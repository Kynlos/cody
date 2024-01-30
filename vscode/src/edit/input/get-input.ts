import * as vscode from 'vscode'
import type { ChatEventSource, ContextFile } from '@sourcegraph/cody-shared'

import * as defaultCommands from '../../commands/prompt/cody.json'
import type { EditSupportedModels } from '../prompt'
import { getEditor } from '../../editor/active-editor'
import { fetchDocumentSymbols, getLabelForContextFile, getTitleRange, removeAfterLastAt } from './utils'
import { type TextChange, updateRangeMultipleChanges } from '../../non-stop/tracked-range'
import { createQuickPick } from './quick-pick'
import { FILE_HELP_LABEL, NO_MATCHES_LABEL, SYMBOL_HELP_LABEL } from './constants'
import { getMatchingContext } from './get-matching-context'
import type { EditIntent, EditRangeSource } from '../types'
import { DOCUMENT_ITEM, MODEL_ITEM, RANGE_ITEM, TEST_ITEM, getEditInputItems } from './get-items/edit'
import { MODEL_ITEMS, getModelInputItems } from './get-items/model'
import { getRangeInputItems } from './get-items/range'
import { getDocumentInputItems } from './get-items/document'
import { getTestInputItems } from './get-items/test'
import { executeEdit } from '../execute'
import type { EditRangeItem } from './get-items/types'
import { CURSOR_RANGE_ITEM, EXPANDED_RANGE_ITEM, SELECTION_RANGE_ITEM } from './get-items/constants'

interface QuickPickInput {
    /** The user provided instruction */
    instruction: string
    /** Any user provided context, from @ or @# */
    userContextFiles: ContextFile[]
    /** The LLM that the user has selected */
    model: EditSupportedModels
    /** The range that the user has selected */
    range: vscode.Range
    /** The source of the range selection */
    rangeSource: EditRangeSource
}

export interface EditInputInitialValues {
    initialRange: vscode.Range
    initialExpandedRange?: vscode.Range
    initialModel: EditSupportedModels
    initialRangeSource: EditRangeSource
    initialInputValue?: string
    initialSelectedContextFiles?: ContextFile[]
}

const PREVIEW_RANGE_DECORATION = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightTextBackground'),
    borderColor: new vscode.ThemeColor('editor.wordHighlightTextBorder'),
})

export const getInput = async (
    document: vscode.TextDocument,
    intent: EditIntent,
    initialValues: EditInputInitialValues,
    source: ChatEventSource
): Promise<QuickPickInput | null> => {
    const editor = getEditor().active
    if (!editor) {
        return null
    }

    let activeRange = initialValues.initialExpandedRange || initialValues.initialRange
    let activeRangeItem =
        intent === 'add'
            ? CURSOR_RANGE_ITEM
            : initialValues.initialExpandedRange
              ? EXPANDED_RANGE_ITEM
              : SELECTION_RANGE_ITEM
    let activeModel: EditSupportedModels = initialValues.initialModel
    const activeRangeSource: EditRangeSource = initialValues.initialRangeSource

    // ContextItems to store possible user-provided context
    const contextItems = new Map<string, ContextFile>()
    const selectedContextItems = new Map<string, ContextFile>()

    // Initialize the selectedContextItems with any previous items
    // This is primarily for edit retries, where a user may want to reuse their context
    for (const file of initialValues.initialSelectedContextFiles ?? []) {
        selectedContextItems.set(getLabelForContextFile(file), file)
    }

    /**
     * Set the title of the quick pick to include the file and range
     * Update the title as the range changes
     */
    const relativeFilePath = vscode.workspace.asRelativePath(document.uri.fsPath)
    let activeTitle: string
    const updateActiveTitle = (newRange: vscode.Range) => {
        const fileRange = getTitleRange(newRange)
        activeTitle = `Edit ${relativeFilePath}:${fileRange} with Cody`
    }
    updateActiveTitle(activeRange)

    /**
     * Listens for text document changes and updates the range when changes occur.
     * This allows the range to stay in sync if the user continues editing after
     * requesting the refactoring.
     */
    const registerRangeListener = () => {
        return vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== document) {
                return
            }

            const changes = new Array<TextChange>(...event.contentChanges)
            const updatedRange = updateRangeMultipleChanges(activeRange, changes)
            if (!updatedRange.isEqual(activeRange)) {
                activeRange = updatedRange
                updateActiveTitle(activeRange)
            }
        })
    }
    let textDocumentListener = registerRangeListener()
    const updateActiveRange = (range: vscode.Range) => {
        // Clear any set decorations
        editor.setDecorations(PREVIEW_RANGE_DECORATION, [])

        // Pause listening to range changes to avoid a possible race condition
        textDocumentListener.dispose()

        editor.selection = new vscode.Selection(range.start, range.end)
        activeRange = range

        // Resume listening to range changes
        textDocumentListener = registerRangeListener()
        // Update the title to reflect the new range
        updateActiveTitle(activeRange)
    }
    const previewActiveRange = (range: vscode.Range) => {
        editor.setDecorations(PREVIEW_RANGE_DECORATION, [range])
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    }

    if (initialValues.initialExpandedRange) {
        previewActiveRange(initialValues.initialExpandedRange)
    }

    // Start fetching symbols early, so they can be used immediately if an option is selected
    const symbolsPromise = fetchDocumentSymbols(document)

    return new Promise(resolve => {
        const modelInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Select a model',
            getItems: () => getModelInputItems(activeModel),
            buttons: [vscode.QuickInputButtons.Back],
            onDidTriggerButton: () => editInput.render(activeTitle, editInput.input.value),
            onDidChangeActive: items => {
                const item = items[0]
                if (item.label === MODEL_ITEMS['anthropic/claude-2.1'].label) {
                    activeModel = 'anthropic/claude-2.1'
                    return
                }
                if (item.label === MODEL_ITEMS['anthropic/claude-instant-1.2'].label) {
                    activeModel = 'anthropic/claude-instant-1.2'
                    return
                }
            },
            onDidAccept: () => editInput.render(activeTitle, editInput.input.value),
        })

        const rangeInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Select a range to edit',
            getItems: () => getRangeInputItems(document, initialValues, activeRange, symbolsPromise),
            buttons: [vscode.QuickInputButtons.Back],
            onDidTriggerButton: () => editInput.render(activeTitle, editInput.input.value),
            onDidHide: () => editor.setDecorations(PREVIEW_RANGE_DECORATION, []),
            onDidChangeActive: async items => {
                const item = items[0] as EditRangeItem
                const range = item.range instanceof vscode.Range ? item.range : await item.range()
                previewActiveRange(range)
            },
            onDidAccept: async () => {
                const acceptedItem = rangeInput.input.activeItems[0] as EditRangeItem
                activeRangeItem = acceptedItem
                const range =
                    acceptedItem.range instanceof vscode.Range
                        ? acceptedItem.range
                        : await acceptedItem.range()

                updateActiveRange(range)
                editInput.render(activeTitle, editInput.input.value)
            },
        })

        const documentInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Select a symbol to document',
            getItems: () => getDocumentInputItems(document, initialValues, activeRange, symbolsPromise),
            buttons: [vscode.QuickInputButtons.Back],
            onDidTriggerButton: () => editInput.render(activeTitle, editInput.input.value),
            onDidHide: () => editor.setDecorations(PREVIEW_RANGE_DECORATION, []),
            onDidChangeActive: async items => {
                const item = items[0] as EditRangeItem
                const range = item.range instanceof vscode.Range ? item.range : await item.range()
                previewActiveRange(range)
            },
            onDidAccept: async () => {
                // Use the accepted range
                const acceptedItem = documentInput.input.activeItems[0] as EditRangeItem
                const range =
                    acceptedItem.range instanceof vscode.Range
                        ? acceptedItem.range
                        : await acceptedItem.range()

                // Expand the range from the node to include the full lines
                const fullDocumentableRange = new vscode.Range(
                    document.lineAt(range.start.line).range.start,
                    document.lineAt(range.end.line).range.end
                )
                updateActiveRange(fullDocumentableRange)

                // Hide the input and execute a new edit for 'Document'
                documentInput.input.hide()
                return executeEdit(
                    {
                        document,
                        instruction: defaultCommands.commands.doc.prompt,
                        range: activeRange,
                        intent: 'doc',
                        mode: 'insert',
                        contextMessages: [],
                        userContextFiles: [],
                    },
                    'menu'
                )
            },
        })

        const unitTestInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Select a symbol to generate tests',
            getItems: () =>
                getTestInputItems(editor.document, initialValues, activeRange, symbolsPromise),
            buttons: [vscode.QuickInputButtons.Back],
            onDidTriggerButton: () => editInput.render(activeTitle, editInput.input.value),
            onDidHide: () => editor.setDecorations(PREVIEW_RANGE_DECORATION, []),
            onDidChangeActive: async items => {
                const item = items[0] as EditRangeItem
                const range = item.range instanceof vscode.Range ? item.range : await item.range()
                previewActiveRange(range)
            },
            onDidAccept: async () => {
                // Use the accepted range
                const acceptedItem = unitTestInput.input.activeItems[0] as EditRangeItem
                const range =
                    acceptedItem.range instanceof vscode.Range
                        ? acceptedItem.range
                        : await acceptedItem.range()
                updateActiveRange(range)

                // Hide the input and execute a new edit for 'Test'
                unitTestInput.input.hide()
                // TODO: This should entirely run through `executeEdit` when
                // the unit test command has fully moved over to Edit.
                return vscode.commands.executeCommand('cody.command.unit-tests')
            },
        })

        const editInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Enter edit instructions (type @ to include code, ⏎ to submit)',
            getItems: () => getEditInputItems(editInput.input.value, activeRangeItem, activeModel),
            onDidHide: () => editor.setDecorations(PREVIEW_RANGE_DECORATION, []),
            ...(source === 'menu'
                ? {
                      buttons: [vscode.QuickInputButtons.Back],
                      onDidTriggerButton: target => {
                          if (target === vscode.QuickInputButtons.Back) {
                              void vscode.commands.executeCommand('cody.action.commands.menu')
                              editInput.input.hide()
                          }
                      },
                  }
                : {}),
            onDidChangeValue: async value => {
                const input = editInput.input
                if (
                    initialValues.initialInputValue !== undefined &&
                    value === initialValues.initialInputValue
                ) {
                    // Noop, this event is fired when an initial value is set
                    return
                }

                const isFileSearch = value.endsWith('@')
                const isSymbolSearch = value.endsWith('@#')

                // If we have the beginning of a file or symbol match, show a helpful label
                if (isFileSearch) {
                    input.items = [{ alwaysShow: true, label: FILE_HELP_LABEL }]
                    return
                }
                if (isSymbolSearch) {
                    input.items = [{ alwaysShow: true, label: SYMBOL_HELP_LABEL }]
                    return
                }

                const matchingContext = await getMatchingContext(value)
                if (matchingContext === null) {
                    // Nothing to match, clear existing items
                    // eslint-disable-next-line no-self-assign
                    input.items = getEditInputItems(input.value, activeRangeItem, activeModel).items
                    return
                }

                if (matchingContext.length === 0) {
                    // Attempted to match but found nothing
                    input.items = [{ alwaysShow: true, label: NO_MATCHES_LABEL }]
                    return
                }

                // Update stored context items so we can retrieve them later
                for (const { key, file } of matchingContext) {
                    contextItems.set(key, file)
                }

                // Add human-friendly labels to the quick pick so the user can select them
                input.items = matchingContext.map(({ key, shortLabel }) => ({
                    alwaysShow: true,
                    label: shortLabel || key,
                    description: shortLabel ? key : undefined,
                }))
            },
            onDidAccept: () => {
                const input = editInput.input
                const instruction = input.value.trim()

                // Selected item flow, update the input and store it for submission
                const selectedItem = input.selectedItems[0]
                switch (selectedItem.label) {
                    case MODEL_ITEM.label:
                        modelInput.render(activeTitle, '')
                        return
                    case RANGE_ITEM.label:
                        rangeInput.render(activeTitle, '')
                        return
                    case DOCUMENT_ITEM.label:
                        documentInput.render(activeTitle, '')
                        return
                    case TEST_ITEM.label:
                        unitTestInput.render(activeTitle, '')
                        return
                }

                // Empty input flow, do nothing
                if (!instruction) {
                    return
                }

                // User provided context flow, the `key` is provided as the `description` for symbol items, use this if available.
                const key = selectedItem?.description || selectedItem?.label
                if (selectedItem) {
                    const contextItem = contextItems.get(key)
                    if (contextItem) {
                        // Replace fuzzy value with actual context in input
                        input.value = `${removeAfterLastAt(instruction)}@${key} `
                        selectedContextItems.set(key, contextItem)
                        return
                    }
                }

                // Submission flow, validate selected items and return final output
                input.hide()
                textDocumentListener.dispose()
                return resolve({
                    instruction: instruction.trim(),
                    userContextFiles: Array.from(selectedContextItems)
                        .filter(([key]) => instruction.includes(`@${key}`))
                        .map(([, value]) => value),
                    model: activeModel,
                    range: activeRange,
                    rangeSource: activeRangeSource,
                })
            },
        })

        editInput.render(activeTitle, initialValues.initialInputValue || '')
        editInput.input.activeItems = []
    })
}