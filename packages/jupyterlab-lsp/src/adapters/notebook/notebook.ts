import { WidgetAdapter } from '../adapter';
import { Notebook, NotebookPanel } from '@jupyterlab/notebook';
import { until_ready } from '../../utils';
import { Cell, ICellModel } from '@jupyterlab/cells';
import * as nbformat from '@jupyterlab/nbformat';
import ILanguageInfoMetadata = nbformat.ILanguageInfoMetadata;
import { Session } from '@jupyterlab/services';
import { SessionContext } from '@jupyterlab/apputils';
import { LSPExtension } from '../../index';
import { PositionConverter } from '../../converter';
import { IEditorPosition, IVirtualPosition } from '../../positioning';
import { ICommandContext } from '../../command_manager';
import { CodeEditor } from '@jupyterlab/codeeditor';
import IEditor = CodeEditor.IEditor;
import { VirtualDocument } from '../../virtual/document';

export class NotebookAdapter extends WidgetAdapter<NotebookPanel> {
  editor: Notebook;
  private ce_editor_to_cell: Map<IEditor, Cell>;
  private known_editors_ids: Set<string>;

  private _language_info: ILanguageInfoMetadata;
  private type: nbformat.CellType = 'code';

  constructor(extension: LSPExtension, editor_widget: NotebookPanel) {
    super(extension, editor_widget);
    this.ce_editor_to_cell = new Map();
    this.editor = editor_widget.content;
    this.known_editors_ids = new Set();
    this.init_once_ready().catch(console.warn);
  }

  private async update_language_info() {
    this._language_info = (
      await this.widget.context.sessionContext.session.kernel.info
    ).language_info;
  }

  async on_kernel_changed(
    _session: SessionContext,
    change: Session.ISessionConnection.IKernelChangedArgs
  ) {
    if (!change.newValue) {
      console.log('LSP: kernel was shut down');
      return;
    }
    try {
      await this.update_language_info();
      console.log(
        `LSP: Changed to ${this._language_info.name} kernel, reconnecting`
      );
      await until_ready(this.is_ready, -1);
      this.reload_connection();
    } catch (err) {
      console.warn(err);
      // try to reconnect anyway
      this.reload_connection();
    }
  }

  dispose() {
    if (this.isDisposed) {
      return;
    }

    this.widget.context.sessionContext.kernelChanged.disconnect(
      this.on_kernel_changed,
      this
    );
    this.widget.content.activeCellChanged.disconnect(
      this.activeCellChanged,
      this
    );

    super.dispose();

    // editors are needed for the parent dispose() to unbind signals, so they are the last to go
    this.ce_editor_to_cell.clear();
  }

  is_ready = () => {
    return (
      !this.widget.isDisposed &&
      this.widget.context.isReady &&
      this.widget.content.isVisible &&
      this.widget.content.widgets.length > 0 &&
      this.widget.context.sessionContext.session?.kernel != null
    );
  };

  get document_path(): string {
    return this.widget.context.path;
  }

  protected language_info(): ILanguageInfoMetadata {
    return this._language_info;
  }

  get mime_type(): string {
    let language_metadata = this.language_info();
    if (!language_metadata) {
      // fallback to the code cell mime type if no kernel in use
      return this.widget.content.codeMimetype;
    }
    return language_metadata.mimetype;
  }

  get language_file_extension(): string {
    let language_metadata = this.language_info();
    if (!language_metadata) {
      return null;
    }
    return language_metadata.file_extension.replace('.', '');
  }

  get wrapper_element() {
    return this.widget.node;
  }

  async init_once_ready() {
    console.log('LSP: waiting for', this.document_path, 'to fully load');
    await this.widget.context.sessionContext.ready;
    await until_ready(this.is_ready, -1);
    await this.update_language_info();
    console.log('LSP:', this.document_path, 'ready for connection');

    this.init_virtual();
    this.connect_contentChanged_signal();

    // connect the document, but do not open it as the adapter will handle this
    // after registering all features
    this.connect_document(this.virtual_editor.virtual_document, false).catch(
      console.warn
    );

    this.widget.context.sessionContext.kernelChanged.connect(
      this.on_kernel_changed,
      this
    );

    this.widget.content.activeCellChanged.connect(this.activeCellChanged, this);
    this.widget.model.cells.changed.connect(async (cells, change) => {
      let cellsAdded: ICellModel[] = [];
      let cellsRemoved: ICellModel[] = [];
      const type = this.type;

      if (change.type === 'set') {
        // handling of conversions is important, because the editors get re-used and their handlers inherited,
        // so we need to clear our handlers from editors of e.g. markdown cells which previously were code cells.
        let convertedToMarkdownOrRaw = [];
        let convertedToCode = [];

        if (change.newValues.length === change.oldValues.length) {
          // during conversion the cells should not get deleted nor added
          for (let i = 0; i < change.newValues.length; i++) {
            if (
              change.oldValues[i].type === type &&
              change.newValues[i].type !== type
            ) {
              convertedToMarkdownOrRaw.push(change.newValues[i]);
            } else if (
              change.oldValues[i].type !== type &&
              change.newValues[i].type === type
            ) {
              convertedToCode.push(change.newValues[i]);
            }
          }
          cellsAdded = convertedToCode;
          cellsRemoved = convertedToMarkdownOrRaw;
        }
      } else if (change.type == 'add') {
        cellsAdded = change.newValues.filter(
          cellModel => cellModel.type === type
        );
      }
      // note: editorRemoved is not emitted for removal of cells by change of type 'remove' (but only during cell type conversion)
      // because there is no easy way to get the widget associated with the removed cell(s) - because it is no
      // longer in the notebook widget list! It would need to be tracked on our side, but it is not necessary
      // as (except for a tiny memory leak) it should not impact the functionality in any way

      if (
        cellsRemoved.length ||
        cellsAdded.length ||
        change.type === 'move' ||
        change.type === 'remove'
      ) {
        // in contrast to the file editor document which can be only changed by the modification of the editor content,
        // the notebook document cna also get modified by a change in the number or arrangement of editors themselves;
        // for this reason each change has to trigger documents update (so that LSP mirror is in sync).
        await this.update_documents();
      }

      for (let cellModel of cellsRemoved) {
        let cellWidget = this.widget.content.widgets.find(
          cell => cell.model.id === cellModel.id
        );
        this.known_editors_ids.delete(cellWidget.editor.uuid);

        // for practical purposes this editor got removed from our consideration;
        // it might seem that we should instead look for the editor indicated by
        // the oldValues[i] cellModel, but this one got already transferred to the
        // markdown cell in newValues[i]
        this.editorRemoved.emit({
          editor: cellWidget.editor
        });
      }

      for (let cellModel of cellsAdded) {
        let cellWidget = this.widget.content.widgets.find(
          cell => cell.model.id === cellModel.id
        );
        this.known_editors_ids.add(cellWidget.editor.uuid);

        this.editorAdded.emit({
          editor: cellWidget.editor
        });
      }
    });
  }

  get editors(): CodeEditor.IEditor[] {
    if (this.isDisposed) {
      return;
    }

    let notebook = this.widget.content;

    this.ce_editor_to_cell.clear();

    if (notebook.isDisposed) {
      return [];
    }

    return notebook.widgets
      .filter(cell => cell.model.type === 'code')
      .map(cell => {
        this.ce_editor_to_cell.set(cell.editor, cell);
        return cell.editor;
      });
  }

  create_virtual_document() {
    return new VirtualDocument({
      language: this.language,
      path: this.document_path,
      overrides_registry: this.code_overrides,
      foreign_code_extractors: this.foreign_code_extractors,
      file_extension: this.language_file_extension,
      // notebooks are continuous, each cell is dependent on the previous one
      standalone: false,
      // notebooks are not supported by LSP servers
      has_lsp_supported_file: false
    });
  }

  get activeEditor() {
    return this.widget.content.activeCell.editor;
  }

  private activeCellChanged(notebook: Notebook, cell: Cell) {
    if (cell.model.type !== this.type) {
      return;
    }
    if (!this.known_editors_ids.has(cell.editor.uuid)) {
      this.known_editors_ids.add(cell.editor.uuid);
      this.editorAdded.emit({
        editor: cell.editor
      });
    }
    this.activeEditorChanged.emit({
      editor: cell.editor
    });
  }

  context_from_active_document(): ICommandContext | null {
    let cell = this.widget.content.activeCell;
    if (cell.model.type !== this.type) {
      // context will be sought on all cells to verify if the context menu should be visible,
      // thus it is ok to just return null; it seems to stem from the implementation detail
      // upstream, i.e. the markdown cells appear to be created by transforming the code cells
      // but do not quote me on that.
      return null;
    }
    let editor = cell.editor;
    let ce_cursor = editor.getCursorPosition();
    let cm_cursor = PositionConverter.ce_to_cm(ce_cursor) as IEditorPosition;

    let virtual_editor = this?.virtual_editor;

    if (virtual_editor == null) {
      return null;
    }

    let root_position = virtual_editor.transform_from_editor_to_root(
      editor,
      cm_cursor
    );

    if (root_position == null) {
      console.warn('Could not retrieve current context', virtual_editor);
      return null;
    }

    return this?.get_context(root_position);
  }

  get_editor_index_at(position: IVirtualPosition): number {
    let cell = this.get_cell_at(position);
    let notebook = this.widget.content;
    return notebook.widgets.findIndex(other_cell => {
      return cell === other_cell;
    });
  }

  get_editor_index(ce_editor: CodeEditor.IEditor): number {
    let cell = this.ce_editor_to_cell.get(ce_editor);
    let notebook = this.widget.content;
    return notebook.widgets.findIndex(other_cell => {
      return cell === other_cell;
    });
  }

  get_editor_wrapper(ce_editor: CodeEditor.IEditor): HTMLElement {
    let cell = this.ce_editor_to_cell.get(ce_editor);
    return cell.node;
  }

  private get_cell_at(pos: IVirtualPosition): Cell {
    let ce_editor = this.virtual_editor.virtual_document.get_editor_at_virtual_line(
      pos
    );
    return this.ce_editor_to_cell.get(ce_editor);
  }
}