const { Plugin, MarkdownView, PluginSettingTab, Setting } = require('obsidian');

const DEFAULT_SETTINGS = {
    autoOpenDailyNote: true,
    scrollToBottom: true,
    insertAtEnd: true,
    chainMode: false,
    timestampFormat: '# HH:MM',
    separators: ''
};

module.exports = class TimestamperPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'insert-timestamp',
            name: 'Insert timestamp',
            callback: () => {
                this.handleTimestampInsertion();
            }
        });

        this.addSettingTab(new TimestamperSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    scrollToBottom(editor) {
        if (!editor || !this.settings.scrollToBottom) return;

        const lastLine = editor.lineCount() - 1;
        const lastChar = editor.getLine(lastLine).length;
        editor.setCursor({ line: lastLine, ch: lastChar });

        const codemirror = editor.cm;
        if (codemirror && codemirror.scrollDOM) {
            const scrollContainer = codemirror.scrollDOM;
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
    }

    getDailyNoteConfiguration() {
        const dailyNotesPlugin = this.app.internalPlugins.plugins['daily-notes']?.instance;
        const dailyNotesSettings = dailyNotesPlugin?.options;

        if (dailyNotesSettings) {
            return {
                format: dailyNotesSettings.format,
                folder: dailyNotesSettings.folder,
                template: dailyNotesSettings.template
            };
        }

        const vaultConfig = this.app.vault.config;
        return {
            format: vaultConfig?.dailyNoteFormat,
            folder: vaultConfig?.dailyNoteFolder,
            template: vaultConfig?.dailyNoteTemplate
        };
    }

    getTodayDailyNotePath() {
        const config = this.getDailyNoteConfiguration();
        const dateFormat = config.format;
        const noteFolder = config.folder;

        const today = window.moment();
        const filename = today.format(dateFormat);

        if (noteFolder && noteFolder !== '/') {
            return `${noteFolder}/${filename}.md`;
        } else {
            return `${filename}.md`;
        }
    }

    isCurrentNoteTodaysDailyNote() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;

        const todayNotePath = this.getTodayDailyNotePath();
        return activeFile.path === todayNotePath;
    }

    async openTodaysDailyNote() {
        const todayNotePath = this.getTodayDailyNotePath();
        let noteFile = this.app.vault.getAbstractFileByPath(todayNotePath);

        if (!noteFile) {
            const config = this.getDailyNoteConfiguration();
            const noteFolder = config.folder;

            if (noteFolder && !this.app.vault.getAbstractFileByPath(noteFolder)) {
                await this.app.vault.createFolder(noteFolder);
            }

            const templatePath = config.template;
            let noteContent = '';

            if (templatePath) {
                const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
                if (templateFile) {
                    noteContent = await this.app.vault.read(templateFile);
                }
            }

            try {
                noteFile = await this.app.vault.create(todayNotePath, noteContent);
            } catch (error) {
                if (error.message.includes("already exists")) {
                    noteFile = this.app.vault.getAbstractFileByPath(todayNotePath);
                    if (!noteFile) {
                        return;
                    }
                } else {
                    throw error;
                }
            }
        }

        const workspaceLeaf = this.app.workspace.getLeaf();
        await workspaceLeaf.openFile(noteFile);
        return this.app.workspace.getActiveViewOfType(MarkdownView);
    }

    async handleTimestampInsertion() {
        let markdownView;

        if (!this.isCurrentNoteTodaysDailyNote() && this.settings.autoOpenDailyNote) {
            markdownView = await this.openTodaysDailyNote();
            if (!markdownView) return;
        } else {
            const activeLeaf = this.app.workspace.activeLeaf;
            if (!activeLeaf) return;

            markdownView = activeLeaf.view instanceof MarkdownView ? activeLeaf.view : null;
            if (!markdownView) return;
        }

        let viewState = markdownView.leaf.getViewState();
        let needsViewUpdate = false;

        if (viewState.state?.mode === 'preview' ||
            (viewState.state?.mode === 'source' && viewState.state?.source === true)) {
            viewState.state.mode = 'source';
            viewState.state.source = false;
            needsViewUpdate = true;
        }

        if (needsViewUpdate) {
            await markdownView.leaf.setViewState(viewState);
            this.app.workspace.setActiveLeaf(markdownView.leaf, { focus: true });

            const updatedView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (updatedView && updatedView.editor) {
                updatedView.editor.focus();
                this.insertTimestamp(updatedView.editor);
                this.scrollToBottom(updatedView.editor);
            }
        } else {
            this.insertTimestamp(markdownView.editor);
            this.scrollToBottom(markdownView.editor);
        }
    }

    findNextEmptyLine(editor, startLine) {
        const totalLines = editor.lineCount();

        for (let lineIndex = startLine; lineIndex < totalLines; lineIndex++) {
            const lineContent = editor.getLine(lineIndex);
            if (lineContent.trim() === '') {
                return lineIndex;
            }
        }
        return totalLines;
    }

    findLastTimestamp(editor) {
        const totalLines = editor.lineCount();
        const timestampPattern = this.settings.timestampFormat
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace('HH', '\\d{2}')
            .replace('MM', '\\d{2}');
        const regex = new RegExp('^' + timestampPattern);

        let lastTimestampLine = -1;

        for (let i = 0; i < totalLines; i++) {
            const line = editor.getLine(i);
            if (regex.test(line.trim())) {
                lastTimestampLine = i;
            }
        }

        return lastTimestampLine;
    }

    getSeparatorList() {
        if (!this.settings.separators || this.settings.separators.trim() === '') {
            return [];
        }
        return this.settings.separators
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }

    isSeparatorLine(line) {
        const separators = this.getSeparatorList();
        if (separators.length === 0) return false;

        const trimmedLine = line.trim();
        return separators.some(sep => trimmedLine.startsWith(sep));
    }

    findContentEndAfterTimestamp(editor, timestampLine) {
        const totalLines = editor.lineCount();
        let lastContentLine = timestampLine;

        for (let i = timestampLine + 1; i < totalLines; i++) {
            const line = editor.getLine(i);

            if (this.isSeparatorLine(line)) {
                break;
            }

            if (line.trim() !== '') {
                lastContentLine = i;
            }
        }

        return lastContentLine;
    }

    insertTimestamp(editor) {
        if (!editor) return;

        const currentTime = new Date();
        const hours = String(currentTime.getHours()).padStart(2, '0');
        const minutes = String(currentTime.getMinutes()).padStart(2, '0');

        const formattedTimestamp = this.settings.timestampFormat
            .replace('HH', hours)
            .replace('MM', minutes);

        if (this.settings.chainMode) {
            this.insertTimestampChain(editor, formattedTimestamp);
        } else if (this.settings.insertAtEnd) {
            this.insertTimestampAtDocumentEnd(editor, formattedTimestamp);
        } else {
            this.insertTimestampAtCursorPosition(editor, formattedTimestamp);
        }
    }

    insertTimestampChain(editor, timestamp) {
        const lastTimestampLine = this.findLastTimestamp(editor);

        if (lastTimestampLine === -1) {
            this.insertTimestampAtDocumentEnd(editor, timestamp);
            return;
        }

        const contentEndLine = this.findContentEndAfterTimestamp(editor, lastTimestampLine);
        const contentEndCol = editor.getLine(contentEndLine).length;

        editor.replaceRange(`\n\n${timestamp}\n`, { line: contentEndLine, ch: contentEndCol });
        editor.setCursor({ line: contentEndLine + 3, ch: 0 });
    }

    insertTimestampAtDocumentEnd(editor, timestamp) {
        const lastLineIndex = editor.lineCount() - 1;
        const lastLineContent = editor.getLine(lastLineIndex);
        const documentEndPosition = { line: lastLineIndex, ch: lastLineContent.length };

        let textToInsert;
        if (lastLineContent.trim() === '') {
            textToInsert = `${timestamp}\n`;
            editor.replaceRange(textToInsert, { line: lastLineIndex, ch: 0 }, documentEndPosition);
            editor.setCursor({ line: lastLineIndex + 1, ch: 0 });
        } else {
            textToInsert = `\n\n${timestamp}\n`;
            editor.replaceRange(textToInsert, documentEndPosition);
            editor.setCursor({ line: lastLineIndex + 3, ch: 0 });
        }
    }

    insertTimestampAtCursorPosition(editor, timestamp) {
        const cursorPosition = editor.getCursor();
        const emptyLineIndex = this.findNextEmptyLine(editor, cursorPosition.line);
        const emptyLineContent = editor.getLine(emptyLineIndex);

        let textToInsert;
        if (emptyLineContent && emptyLineContent.trim() === '') {
            textToInsert = `${timestamp}\n`;
            editor.replaceRange(
                textToInsert,
                { line: emptyLineIndex, ch: 0 },
                { line: emptyLineIndex, ch: emptyLineContent.length }
            );
            editor.setCursor({ line: emptyLineIndex + 1, ch: 0 });
        } else {
            textToInsert = `\n${timestamp}\n`;
            editor.replaceRange(textToInsert, { line: emptyLineIndex, ch: 0 });
            editor.setCursor({ line: emptyLineIndex + 2, ch: 0 });
        }
    }

    onunload() {}
}

class TimestamperSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Auto-open daily note')
            .setDesc('Automatically open today\'s daily note when inserting a timestamp.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoOpenDailyNote)
                .onChange(async (value) => {
                    this.plugin.settings.autoOpenDailyNote = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Scroll to bottom')
            .setDesc('Automatically scroll to the bottom of the note after inserting a timestamp.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.scrollToBottom)
                .onChange(async (value) => {
                    this.plugin.settings.scrollToBottom = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Insert at document end')
            .setDesc('Insert timestamp at the end of the document. When disabled, inserts at the first empty line below the cursor.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.insertAtEnd)
                .onChange(async (value) => {
                    if (value) {
                        this.plugin.settings.chainMode = false;
                    }
                    this.plugin.settings.insertAtEnd = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(containerEl)
            .setName('Chain mode')
            .setDesc('Insert timestamp after the last timestamp and its content, before separators.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.chainMode)
                .onChange(async (value) => {
                    if (value) {
                        this.plugin.settings.insertAtEnd = false;
                        this.plugin.settings.scrollToBottom = false;
                    }
                    this.plugin.settings.chainMode = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(containerEl)
            .setName('Timestamp format')
            .setDesc('Format for the timestamp.')
            .addText(text => text
                .setPlaceholder('# HH:MM')
                .setValue(this.plugin.settings.timestampFormat)
                .onChange(async (value) => {
                    this.plugin.settings.timestampFormat = value || '# HH:MM';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Separators')
            .setDesc('Comma-separated list of line prefixes that mark the end of content.')
            .addText(text => text
                .setPlaceholder('---,%%')
                .setValue(this.plugin.settings.separators)
                .onChange(async (value) => {
                    this.plugin.settings.separators = value;
                    await this.plugin.saveSettings();
                }));
    }
}
