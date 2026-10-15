/**
 * Markdown-highlighting chat input editor (CodeMirror 6).
 *
 * Renders markdown in place as the user types — inline code gets code
 * styling, `**bold**` bolds, headings size up — while keeping the raw
 * markdown source visible (highlighted source view, not WYSIWYG).
 * Mounted only on non-touch devices (ChatInput gates); mobile/PWA keeps
 * the plain textarea.
 *
 * Default export so `React.lazy(() => import('./MarkdownEditor'))` keeps
 * the CodeMirror stack out of the initial bundle chunk.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';

// Explicit classes so the styles live in styles.scss with the rest of the
// dashboard (HighlightStyle defaults would generate mangled class names).
const mdHighlight = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: 'md-heading' },
  { tag: tags.strong, class: 'md-strong' },
  { tag: tags.emphasis, class: 'md-emphasis' },
  { tag: tags.monospace, class: 'md-code' },
  { tag: tags.link, class: 'md-link' },
  { tag: tags.quote, class: 'md-quote' },
  { tag: tags.strikethrough, class: 'md-strikethrough' },
]);

const chromeTheme = EditorView.theme({
  '&': { height: '100%', background: 'transparent' },
  '.cm-content': { padding: '0', caretColor: 'var(--c-text-2)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder': { color: 'var(--c-text-dimmest)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--c-border)' },
  '.cm-cursor, &.cm-focused .cm-cursor': { borderLeftColor: 'var(--c-text-2)' },
});

export interface MarkdownEditorHandle {
  focus(): void;
  blur(): void;
  moveCursorToEnd(): void;
  contentDOM(): HTMLElement | null;
}

export interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  /** Enter (desktop) — sends the message */
  onSend(): void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onFocus?(): void;
  onBlur?(): void;
  onKeyDown?(e: React.KeyboardEvent<HTMLDivElement>): void;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>((props, ref) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialDoc = useRef(props.value);
  const onChangeRef = useRef(props.onChange);
  const onSendRef = useRef(props.onSend);
  const disabledRef = useRef(props.disabled);
  const placeholderComp = useRef(new Compartment());
  const editableComp = useRef(new Compartment());
  onChangeRef.current = props.onChange;
  onSendRef.current = props.onSend;
  disabledRef.current = props.disabled;

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: initialDoc.current,
        extensions: [
          history(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(mdHighlight),
          chromeTheme,
          placeholderComp.current.of(cmPlaceholder(props.placeholder ?? '')),
          editableComp.current.of(EditorView.editable.of(!disabledRef.current)),
          // Our Enter binding precedes defaultKeymap, so it wins over the
          // stock newline insertion; Shift-Enter falls through to a plain
          // newline like the textarea's {shift+enter} behavior.
          keymap.of([
            { key: 'Shift-Enter', run: insertNewline },
            { key: 'Enter', run: () => {
              // Don't hijack Enter mid-IME-composition
              if (disabledRef.current || view.composing) return false;
              onSendRef.current();
              return true;
            } },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled value: sync external changes (draft restore, send-clear,
  // slash completion) into the editor doc.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    if (doc !== props.value) {
      // Wholesale external replace (draft restore, send-clear, completion):
      // park the cursor at the end — the old caret has no meaningful
      // position in the new text.
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: props.value },
        selection: { anchor: props.value.length },
      });
    }
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: placeholderComp.current.reconfigure(cmPlaceholder(props.placeholder ?? '')) });
  }, [props.placeholder]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableComp.current.reconfigure(EditorView.editable.of(!props.disabled)) });
  }, [props.disabled]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    blur: () => viewRef.current?.contentDOM.blur(),
    moveCursorToEnd: () => {
      const view = viewRef.current;
      if (view) view.dispatch({ selection: { anchor: view.state.doc.length } });
    },
    contentDOM: () => viewRef.current?.contentDOM ?? null,
  }), []);

  return (
    <div
      ref={hostRef}
      className={props.className}
      style={props.style}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      onKeyDown={props.onKeyDown}
    />
  );
});

MarkdownEditor.displayName = 'MarkdownEditor';
export default MarkdownEditor;
