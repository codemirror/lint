import {EditorView, ViewPlugin, Decoration, DecorationSet,
        WidgetType, ViewUpdate, Command, logException, KeyBinding,
        hoverTooltip, Tooltip, showTooltip, gutter, GutterMarker,
        PanelConstructor, Panel, showPanel, getPanel} from "@codemirror/view"
import {Text, StateEffect, StateField, Extension, TransactionSpec, Transaction,
        EditorState, Facet, combineConfig, RangeSet, Range} from "@codemirror/state"
import elt from "crelt"

/// Describes a problem or hint for a piece of code.
export interface Diagnostic {
  /// The start position of the relevant text.
  from: number
  /// The end position. May be equal to `from`, though actually
  /// covering text is preferable.
  to: number
  /// The severity of the problem. This will influence how it is
  /// displayed.
  severity: "info" | "warning" | "error"
  /// An optional source string indicating where the diagnostic is
  /// coming from. You can put the name of your linter here, if
  /// applicable.
  source?: string
  /// The message associated with this diagnostic.
  message: string
  /// An optional array of actions that can be taken on this
  /// diagnostic.
  actions?: readonly Action[]
}

/// An action associated with a diagnostic.
export interface Action {
  /// The label to show to the user. Should be relatively short.
  name: string
  /// The function to call when the user activates this action. Is
  /// given the diagnostic's _current_ position, which may have
  /// changed since the creation of the diagnostic, due to editing.
  apply: (view: EditorView, from: number, to: number) => void
}

type DiagnosticFilter = (diagnostics: readonly Diagnostic[]) => Diagnostic[]

interface LintConfig {
  /// Time to wait (in milliseconds) after a change before running
  /// the linter. Defaults to 750ms.
  delay?: number
  /// Optional filter for diagnostics that generate markers in the
  /// content
  markerFilter?: null | DiagnosticFilter,
  /// Optional filter for diagnostics displayed in a tooltip, which
  /// can also be used to prevent a tooltip appearing
  tooltipFilter?: null | DiagnosticFilter
}

interface LintGutterConfig {
  /// The delay before showing a tooltip when hovering over a lint gutter marker.
  hoverTime?: number,
  /// Optional filter for diagnostics that generate markers in the
  /// gutter
  markerFilter?: null | DiagnosticFilter,
  /// Optional filter for diagnostics displayed in a tooltip, which
  /// can also be used to prevent a tooltip appearing
  tooltipFilter?: null | DiagnosticFilter
}

class SelectedDiagnostic {
  constructor(readonly from: number, readonly to: number, readonly diagnostic: Diagnostic) {}
}

class LintState {
  constructor(readonly diagnostics: DecorationSet,
              readonly panel: PanelConstructor | null,
              readonly selected: SelectedDiagnostic | null) {}

  static init(diagnostics: readonly Diagnostic[], panel: PanelConstructor | null, state: EditorState) {
    // Filter the list of diagnostics for which to create markers
    let markedDiagnostics = diagnostics
    const diagnosticFilter = state.facet(lintConfig).config.markerFilter
    if (diagnosticFilter) {
      markedDiagnostics = diagnosticFilter(markedDiagnostics)
    }

    let ranges = Decoration.set(markedDiagnostics.map((d: Diagnostic) => {
      // For zero-length ranges or ranges covering only a line break, create a widget
      return d.from == d.to || (d.from == d.to - 1 && state.doc.lineAt(d.from).to == d.from)
        ? Decoration.widget({
          widget: new DiagnosticWidget(d),
          diagnostic: d
        }).range(d.from)
        : Decoration.mark({
          attributes: {class: "cm-lintRange cm-lintRange-" + d.severity},
          diagnostic: d
        }).range(d.from, d.to)
    }), true)
    return new LintState(ranges, panel, findDiagnostic(ranges))
  }
}

function findDiagnostic(diagnostics: DecorationSet, diagnostic: Diagnostic | null = null, after = 0): SelectedDiagnostic | null {
  let found: SelectedDiagnostic | null = null
  diagnostics.between(after, 1e9, (from, to, {spec}) => {
    if (diagnostic && spec.diagnostic != diagnostic) return
    found = new SelectedDiagnostic(from, to, spec.diagnostic)
    return false
  })
  return found
}

function hideTooltip(tr: Transaction, tooltip: Tooltip) {
  return !!(tr.effects.some(e => e.is(setDiagnosticsEffect)) || tr.changes.touchesRange(tooltip.pos))
}

function maybeEnableLint(state: EditorState, effects: readonly StateEffect<unknown>[]) {
  return state.field(lintState, false) ? effects : effects.concat(StateEffect.appendConfig.of([
    lintState,
    EditorView.decorations.compute([lintState], state => {
      let {selected, panel} = state.field(lintState)
      return !selected || !panel || selected.from == selected.to ? Decoration.none : Decoration.set([
        activeMark.range(selected.from, selected.to)
      ])
    }),
    hoverTooltip(lintTooltip, {hideOn: hideTooltip}),
    baseTheme
  ]))
}

/// Returns a transaction spec which updates the current set of
/// diagnostics, and enables the lint extension if if wasn't already
/// active.
export function setDiagnostics(state: EditorState, diagnostics: readonly Diagnostic[]): TransactionSpec {
  return {
    effects: maybeEnableLint(state, [setDiagnosticsEffect.of(diagnostics)])
  }
}

/// The state effect that updates the set of active diagnostics. Can
/// be useful when writing an extension that needs to track these.
export const setDiagnosticsEffect = StateEffect.define<readonly Diagnostic[]>()

const togglePanel = StateEffect.define<boolean>()

const movePanelSelection = StateEffect.define<SelectedDiagnostic>()

const lintState = StateField.define<LintState>({
  create() {
    return new LintState(Decoration.none, null, null)
  },
  update(value, tr) {
    if (tr.docChanged) {
      let mapped = value.diagnostics.map(tr.changes), selected = null
      if (value.selected) {
        let selPos = tr.changes.mapPos(value.selected.from, 1)
        selected = findDiagnostic(mapped, value.selected.diagnostic, selPos) || findDiagnostic(mapped, null, selPos)
      }
      value = new LintState(mapped, value.panel, selected)
    }

    for (let effect of tr.effects) {
      if (effect.is(setDiagnosticsEffect)) {
        value = LintState.init(effect.value, value.panel, tr.state)
      } else if (effect.is(togglePanel)) {
        value = new LintState(value.diagnostics, effect.value ? LintPanel.open : null, value.selected)
      } else if (effect.is(movePanelSelection)) {
        value = new LintState(value.diagnostics, value.panel, effect.value)
      }
    }

    return value
  },
  provide: f => [showPanel.from(f, val => val.panel),
                 EditorView.decorations.from(f, s => s.diagnostics)]
})

/// Returns the number of active lint diagnostics in the given state.
export function diagnosticCount(state: EditorState) {
  let lint = state.field(lintState, false)
  return lint ? lint.diagnostics.size : 0
}

const activeMark = Decoration.mark({class: "cm-lintRange cm-lintRange-active"})

function lintTooltip(view: EditorView, pos: number, side: -1 | 1) {
  let {diagnostics} = view.state.field(lintState)
  let found: Diagnostic[] = [], stackStart = 2e8, stackEnd = 0
  diagnostics.between(pos - (side < 0 ? 1 : 0), pos + (side > 0 ? 1 : 0), (from, to, {spec}) => {
    if (pos >= from && pos <= to &&
        (from == to || ((pos > from || side > 0) && (pos < to || side < 0)))) {
      found.push(spec.diagnostic)
      stackStart = Math.min(from, stackStart)
      stackEnd = Math.max(to, stackEnd)
    }
  })

  const diagnosticFilter = view.state.facet(lintConfig).config.tooltipFilter
  if (diagnosticFilter) {
    found = diagnosticFilter(found)
  }

  if (!found.length) return null

  return {
    pos: stackStart,
    end: stackEnd,
    above: view.state.doc.lineAt(stackStart).to < stackEnd,
    create() {
      return {dom: diagnosticsTooltip(view, found)}
    }
  }
}

function diagnosticsTooltip(view: EditorView, diagnostics: readonly Diagnostic[]) {
  return elt("ul", {class: "cm-tooltip-lint"}, diagnostics.map(d => renderDiagnostic(view, d, false)))
}

/// Command to open and focus the lint panel.
export const openLintPanel: Command = (view: EditorView) => {
  let field = view.state.field(lintState, false)
  if (!field || !field.panel)
    view.dispatch({effects: maybeEnableLint(view.state, [togglePanel.of(true)])})
  let panel = getPanel(view, LintPanel.open)
  if (panel) (panel.dom.querySelector(".cm-panel-lint ul") as HTMLElement).focus()
  return true
}

/// Command to close the lint panel, when open.
export const closeLintPanel: Command = (view: EditorView) => {
  let field = view.state.field(lintState, false)
  if (!field || !field.panel) return false
  view.dispatch({effects: togglePanel.of(false)})
  return true
}

/// Move the selection to the next diagnostic.
export const nextDiagnostic: Command = (view: EditorView) => {
  let field = view.state.field(lintState, false)
  if (!field) return false
  let sel = view.state.selection.main, next = field.diagnostics.iter(sel.to + 1)
  if (!next.value) {
    next = field.diagnostics.iter(0)
    if (!next.value || next.from == sel.from && next.to == sel.to) return false
  }
  view.dispatch({selection: {anchor: next.from, head: next.to}, scrollIntoView: true})
  return true
}

/// A set of default key bindings for the lint functionality.
///
/// - Ctrl-Shift-m (Cmd-Shift-m on macOS): [`openLintPanel`](#lint.openLintPanel)
/// - F8: [`nextDiagnostic`](#lint.nextDiagnostic)
export const lintKeymap: readonly KeyBinding[] = [
  {key: "Mod-Shift-m", run: openLintPanel},
  {key: "F8", run: nextDiagnostic}
]

/// The type of a function that produces diagnostics.
export type LintSource = (view: EditorView) => readonly Diagnostic[] | Promise<readonly Diagnostic[]>

const lintPlugin = ViewPlugin.fromClass(class {
  lintTime: number
  timeout = -1
  set = true

  constructor(readonly view: EditorView) {
    let {delay} = view.state.facet(lintConfig).config
    this.lintTime = Date.now() + delay
    this.run = this.run.bind(this)
    this.timeout = setTimeout(this.run, delay)
  }

  run() {
    let now = Date.now()
    if (now < this.lintTime - 10) {
      setTimeout(this.run, this.lintTime - now)
    } else {
      this.set = false
      let {state} = this.view, {sources} = state.facet(lintConfig)
      Promise.all(sources.map(source => Promise.resolve(source(this.view)))).then(
        annotations => {
          let all = annotations.reduce((a, b) => a.concat(b))
          if (this.view.state.doc == state.doc)
            this.view.dispatch(setDiagnostics(this.view.state, all))
        },
        error => { logException(this.view.state, error) }
      )
    }
  }

  update(update: ViewUpdate) {
    let configAndSource = update.state.facet(lintConfig)
    let {delay} = configAndSource.config
    if (update.docChanged || configAndSource != update.startState.facet(lintConfig)) {
      this.lintTime = Date.now() + delay
      if (!this.set) {
        this.set = true
        this.timeout = setTimeout(this.run, delay)
      }
    }
  }

  force() {
    if (this.set) {
      this.lintTime = Date.now()
      this.run()
    }
  }

  destroy() {
    clearTimeout(this.timeout)
  }
})

function mapDefinedProperty(arr: readonly any[], propName: string) {
  return arr.reduce((mapped: any[], obj) => {
    const propValue = obj[propName];
    if (propValue !== undefined) {
      mapped.push(propValue);
    }
    return mapped;
  }, [] as any[])
}

const lintConfig = Facet.define<{source: LintSource, config: LintConfig}, {sources: readonly LintSource[], config: LintConfig}>({
  combine(input) {
    return {
      sources: mapDefinedProperty(input, "source"),
      config: combineConfig(mapDefinedProperty(input, "config"), {
        delay: 750,
        markerFilter: null,
        tooltipFilter: null
      })
    }
  },
  enables: lintPlugin
})

/// Given a diagnostic source, this function returns an extension that
/// enables linting with that source. It will be called whenever the
/// editor is idle (after its content changed).
export function linter(
  source: LintSource,
  config: LintConfig = {}
): Extension {
  return [
    lintConfig.of({source: source, config: config})
  ]
}

/// Forces any linters [configured](#lint.linter) to run when the
/// editor is idle to run right away.
export function forceLinting(view: EditorView) {
  let plugin = view.plugin(lintPlugin)
  if (plugin) plugin.force()
}

function assignKeys(actions: readonly Action[] | undefined) {
  let assigned: string[] = []
  if (actions) actions: for (let {name} of actions) {
    for (let i = 0; i < name.length; i++) {
      let ch = name[i]
      if (/[a-zA-Z]/.test(ch) && !assigned.some(c => c.toLowerCase() == ch.toLowerCase())) {
        assigned.push(ch)
        continue actions
      }
    }
    assigned.push("")
  }
  return assigned
}

function renderDiagnostic(view: EditorView, diagnostic: Diagnostic, inPanel: boolean) {
  let keys = inPanel ? assignKeys(diagnostic.actions) : []
  return elt(
    "li", {class: "cm-diagnostic cm-diagnostic-" + diagnostic.severity},
    elt("span", {class: "cm-diagnosticText"}, diagnostic.message),
    diagnostic.actions?.map((action, i) => {
      let click = (e: Event) => {
        e.preventDefault()
        let found = findDiagnostic(view.state.field(lintState).diagnostics, diagnostic)
        if (found) action.apply(view, found.from, found.to)
      }
      let {name} = action, keyIndex = keys[i] ? name.indexOf(keys[i]) : -1
      let nameElt = keyIndex < 0 ? name : [name.slice(0, keyIndex),
                                           elt("u", name.slice(keyIndex, keyIndex + 1)),
                                           name.slice(keyIndex + 1)]
      return elt("button", {
        type: "button",
        class: "cm-diagnosticAction",
        onclick: click,
        onmousedown: click,
        "aria-label": ` Action: ${name}${keyIndex < 0 ? "" : ` (access key "${keys[i]})"`}.`
      }, nameElt)
    }),
    diagnostic.source && elt("div", {class: "cm-diagnosticSource"}, diagnostic.source))
}

class DiagnosticWidget extends WidgetType {
  constructor(readonly diagnostic: Diagnostic) {super()}

  eq(other: DiagnosticWidget) { return other.diagnostic == this.diagnostic }

  toDOM() {
    return elt("span", {class: "cm-lintPoint cm-lintPoint-" + this.diagnostic.severity})
  }
}

class PanelItem {
  id = "item_" + Math.floor(Math.random() * 0xffffffff).toString(16)
  dom: HTMLElement

  constructor(view: EditorView, readonly diagnostic: Diagnostic) {
    this.dom = renderDiagnostic(view, diagnostic, true)
    this.dom.id = this.id
    this.dom.setAttribute("role", "option")
  }
}

class LintPanel implements Panel {
  items: PanelItem[] = []
  dom: HTMLElement
  list: HTMLElement

  constructor(readonly view: EditorView) {
    let onkeydown = (event: KeyboardEvent) => {
      if (event.keyCode == 27) { // Escape
        closeLintPanel(this.view)
        this.view.focus()
      } else if (event.keyCode == 38 || event.keyCode == 33) { // ArrowUp, PageUp
        this.moveSelection((this.selectedIndex - 1 + this.items.length) % this.items.length)
      } else if (event.keyCode == 40 || event.keyCode == 34) { // ArrowDown, PageDown
        this.moveSelection((this.selectedIndex + 1) % this.items.length)
      } else if (event.keyCode == 36) { // Home
        this.moveSelection(0)
      } else if (event.keyCode == 35) { // End
        this.moveSelection(this.items.length - 1)
      } else if (event.keyCode == 13) { // Enter
        this.view.focus()
      } else if (event.keyCode >= 65 && event.keyCode <= 90 && this.selectedIndex >= 0) { // A-Z
        let {diagnostic} = this.items[this.selectedIndex], keys = assignKeys(diagnostic.actions)
        for (let i = 0; i < keys.length; i++) if (keys[i].toUpperCase().charCodeAt(0) == event.keyCode) {
          let found = findDiagnostic(this.view.state.field(lintState).diagnostics, diagnostic)
          if (found) diagnostic.actions![i].apply(view, found.from, found.to)
        }
      } else {
        return
      }
      event.preventDefault()
    }
    let onclick = (event: MouseEvent) => {
      for (let i = 0; i < this.items.length; i++) {
        if (this.items[i].dom.contains(event.target as HTMLElement))
          this.moveSelection(i)
      }
    }

    this.list = elt("ul", {
      tabIndex: 0,
      role: "listbox",
      "aria-label": this.view.state.phrase("Diagnostics"),
      onkeydown,
      onclick
    })
    this.dom = elt("div", {class: "cm-panel-lint"}, this.list, elt("button", {
      type: "button",
      name: "close",
      "aria-label": this.view.state.phrase("close"),
      onclick: () => closeLintPanel(this.view)
    }, "×"))
    this.update()
  }

  get selectedIndex() {
    let selected = this.view.state.field(lintState).selected
    if (!selected) return -1
    for (let i = 0; i < this.items.length; i++) if (this.items[i].diagnostic == selected.diagnostic) return i
    return -1
  }

  update() {
    let {diagnostics, selected} = this.view.state.field(lintState)
    let i = 0, needsSync = false, newSelectedItem: PanelItem | null = null
    diagnostics.between(0, this.view.state.doc.length, (_start, _end, {spec}) => {
      let found = -1, item
      for (let j = i; j < this.items.length; j++)
        if (this.items[j].diagnostic == spec.diagnostic) { found = j; break }
      if (found < 0) {
        item = new PanelItem(this.view, spec.diagnostic)
        this.items.splice(i, 0, item)
        needsSync = true
      } else {
        item = this.items[found]
        if (found > i) { this.items.splice(i, found - i); needsSync = true }
      }
      if (selected && item.diagnostic == selected.diagnostic) {
        if (!item.dom.hasAttribute("aria-selected")) {
          item.dom.setAttribute("aria-selected", "true")
          newSelectedItem = item
        }
      } else if (item.dom.hasAttribute("aria-selected")) {
        item.dom.removeAttribute("aria-selected")
      }
      i++
    })
    while (i < this.items.length && !(this.items.length == 1 && this.items[0].diagnostic.from < 0)) {
      needsSync = true
      this.items.pop()
    }
    if (this.items.length == 0) {
      this.items.push(new PanelItem(this.view, {
        from: -1, to: -1,
        severity: "info",
        message: this.view.state.phrase("No diagnostics")
      }))
      needsSync = true
    }
    if (newSelectedItem) {
      this.list.setAttribute("aria-activedescendant", newSelectedItem!.id)
      this.view.requestMeasure({
        key: this,
        read: () => ({sel: newSelectedItem!.dom.getBoundingClientRect(), panel: this.list.getBoundingClientRect()}),
        write: ({sel, panel}) => {
          if (sel.top < panel.top) this.list.scrollTop -= panel.top - sel.top
          else if (sel.bottom > panel.bottom) this.list.scrollTop += sel.bottom - panel.bottom
        }
      })
    } else if (this.selectedIndex < 0) {
      this.list.removeAttribute("aria-activedescendant")
    }
    if (needsSync) this.sync()
  }

  sync() {
    let domPos: ChildNode | null = this.list.firstChild
    function rm() {
      let prev = domPos!
      domPos = prev.nextSibling
      prev.remove()
    }

    for (let item of this.items) {
      if (item.dom.parentNode == this.list) {
        while (domPos != item.dom) rm()
        domPos = item.dom.nextSibling
      } else {
        this.list.insertBefore(item.dom, domPos)
      }
    }
    while (domPos) rm()
  }

  moveSelection(selectedIndex: number) {
    if (this.selectedIndex < 0) return
    let field = this.view.state.field(lintState)
    let selection = findDiagnostic(field.diagnostics, this.items[selectedIndex].diagnostic)
    if (!selection) return
    this.view.dispatch({
      selection: {anchor: selection.from, head: selection.to},
      scrollIntoView: true,
      effects: movePanelSelection.of(selection)
    })
  }

  static open(view: EditorView) { return new LintPanel(view) }
}

function svg(content: string, attrs = `viewBox="0 0 40 40"`) {
  return `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${encodeURIComponent(content)}</svg>')`
}

function underline(color: string) {
  return svg(`<path d="m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0" stroke="${color}" fill="none" stroke-width=".7"/>`,
             `width="6" height="3"`)
}

const baseTheme = EditorView.baseTheme({
  ".cm-diagnostic": {
    padding: "3px 6px 3px 8px",
    marginLeft: "-1px",
    display: "block",
    whiteSpace: "pre-wrap"
  },
  ".cm-diagnostic-error": { borderLeft: "5px solid #d11" },
  ".cm-diagnostic-warning": { borderLeft: "5px solid orange" },
  ".cm-diagnostic-info": { borderLeft: "5px solid #999" },

  ".cm-diagnosticAction": {
    font: "inherit",
    border: "none",
    padding: "2px 4px",
    backgroundColor: "#444",
    color: "white",
    borderRadius: "3px",
    marginLeft: "8px"
  },

  ".cm-diagnosticSource": {
    fontSize: "70%",
    opacity: .7
  },

  ".cm-lintRange": {
    backgroundPosition: "left bottom",
    backgroundRepeat: "repeat-x",
    paddingBottom: "0.7px",
  },

  ".cm-lintRange-error": { backgroundImage: underline("#d11") },
  ".cm-lintRange-warning": { backgroundImage: underline("orange") },
  ".cm-lintRange-info": { backgroundImage: underline("#999") },
  ".cm-lintRange-active": { backgroundColor: "#ffdd9980" },

  ".cm-tooltip-lint": {
    padding: 0,
    margin: 0
  },

  ".cm-lintPoint": {
    position: "relative",

    "&:after": {
      content: '""',
      position: "absolute",
      bottom: 0,
      left: "-2px",
      borderLeft: "3px solid transparent",
      borderRight: "3px solid transparent",
      borderBottom: "4px solid #d11"
    }
  },

  ".cm-lintPoint-warning": {
    "&:after": { borderBottomColor: "orange" }
  },
  ".cm-lintPoint-info": {
    "&:after": { borderBottomColor: "#999" }
  },

  ".cm-panel.cm-panel-lint": {
    position: "relative",
    "& ul": {
      maxHeight: "100px",
      overflowY: "auto",
      "& [aria-selected]": {
        backgroundColor: "#ddd",
        "& u": { textDecoration: "underline" }
      },
      "&:focus [aria-selected]": {
        background_fallback: "#bdf",
        backgroundColor: "Highlight",
        color_fallback: "white",
        color: "HighlightText"
      },
      "& u": { textDecoration: "none" },
      padding: 0,
      margin: 0
    },
    "& [name=close]": {
      position: "absolute",
      top: "0",
      right: "2px",
      background: "inherit",
      border: "none",
      font: "inherit",
      padding: 0,
      margin: 0
    }
  }
})

class LintGutterMarker extends GutterMarker {
  severity: "info" | "warning" | "error"
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super()
    this.severity = diagnostics.reduce((max, d) => {
      let s = d.severity
      return s == "error" || s == "warning" && max == "info" ? s : max
    }, "info" as "info" | "warning" | "error")
  }

  toDOM(view: EditorView) {
    let elt = document.createElement("div")
    elt.className = "cm-lint-marker cm-lint-marker-" + this.severity

    let diagnostics = this.diagnostics
    const diagnosticsFilter = view.state.facet(lintGutterConfig).tooltipFilter
    if (diagnosticsFilter) {
      diagnostics = diagnosticsFilter(diagnostics)
    }

    if (diagnostics.length) {
      elt.onmouseover = () => gutterMarkerMouseOver(view, elt, diagnostics)
    }

    return elt
  }
}

const enum Hover {
  Time = 300,
  Margin = 10,
}

function trackHoverOn(view: EditorView, marker: HTMLElement) {
  let mousemove = (event: MouseEvent) => {
    let rect = marker.getBoundingClientRect()
    if (event.clientX > rect.left - Hover.Margin && event.clientX < rect.right + Hover.Margin &&
        event.clientY > rect.top - Hover.Margin && event.clientY < rect.bottom + Hover.Margin)
      return
    for (let target = event.target as Node | null; target; target = target.parentNode) {
      if (target.nodeType == 1 && (target as HTMLElement).classList.contains("cm-tooltip-lint"))
        return
    }
    window.removeEventListener("mousemove", mousemove)
    if (view.state.field(lintGutterTooltip))
      view.dispatch({effects: setLintGutterTooltip.of(null)})
  }
  window.addEventListener("mousemove", mousemove)
}

function gutterMarkerMouseOver(view: EditorView, marker: HTMLElement, diagnostics: readonly Diagnostic[]) {
  function hovered() {
    let line = view.elementAtHeight(marker.getBoundingClientRect().top + 5 - view.documentTop)
    const linePos = view.coordsAtPos(line.from)
    if (linePos) {
      view.dispatch({effects: setLintGutterTooltip.of({
        pos: line.from,
        above: false,
        create() {
          return {
            dom: diagnosticsTooltip(view, diagnostics),
            getCoords: () => marker.getBoundingClientRect()
          }
        }
      })})
    }
    marker.onmouseout = marker.onmousemove = null
    trackHoverOn(view, marker)
  }

  let {hoverTime} = view.state.facet(lintGutterConfig)

  let hoverTimeout = setTimeout(hovered, hoverTime)
  marker.onmouseout = () => {
    clearTimeout(hoverTimeout)
    marker.onmouseout = marker.onmousemove = null
  }
  marker.onmousemove = () => {
    clearTimeout(hoverTimeout)
    hoverTimeout = setTimeout(hovered, hoverTime)
  }
}

function markersForDiagnostics(doc: Text, diagnostics: readonly Diagnostic[]) {
  let byLine: {[line: number]: Diagnostic[]} = Object.create(null)
  for (let diagnostic of diagnostics) {
    let line = doc.lineAt(diagnostic.from)
    ;(byLine[line.from] || (byLine[line.from] = [])).push(diagnostic)
  }
  let markers: Range<GutterMarker>[] = []
  for (let line in byLine) {
    markers.push(new LintGutterMarker(byLine[line]).range(+line))
  }
  return RangeSet.of(markers, true)
}

const lintGutterExtension = gutter({
  class: "cm-gutter-lint",
  markers: view => view.state.field(lintGutterMarkers),
})

const lintGutterMarkers = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty
  },
  update(markers, tr) {
    markers = markers.map(tr.changes)
    const diagnosticFilter = tr.state.facet(lintGutterConfig).markerFilter
    for (let effect of tr.effects) {
      if (effect.is(setDiagnosticsEffect)) {
        let diagnostics = effect.value
        if (diagnosticFilter) {
          diagnostics = diagnosticFilter(diagnostics || []);
        }
        markers = markersForDiagnostics(tr.state.doc, diagnostics.slice(0));
      }
    }
    return markers
  }
})

const setLintGutterTooltip = StateEffect.define<Tooltip | null>()

const lintGutterTooltip = StateField.define<Tooltip | null>({
  create() { return null },
  update(tooltip, tr) {
    if (tooltip && tr.docChanged)
      tooltip = hideTooltip(tr, tooltip) ? null : {...tooltip, pos: tr.changes.mapPos(tooltip.pos)}
    return tr.effects.reduce((t, e) => e.is(setLintGutterTooltip) ? e.value : t, tooltip)
  },
  provide: field => showTooltip.from(field)
})

const lintGutterTheme = EditorView.baseTheme({
  ".cm-gutter-lint": {
    width: "1.4em",
    "& .cm-gutterElement": {
      padding: ".2em"
    }
  },
  ".cm-lint-marker": {
    width: "1em",
    height: "1em"
  },
  ".cm-lint-marker-info": {
    content: svg(`<path fill="#aaf" stroke="#77e" stroke-width="6" stroke-linejoin="round" d="M5 5L35 5L35 35L5 35Z"/>`)
  },
  ".cm-lint-marker-warning": {
    content: svg(`<path fill="#fe8" stroke="#fd7" stroke-width="6" stroke-linejoin="round" d="M20 6L37 35L3 35Z"/>`),
  },
  ".cm-lint-marker-error:before": {
    content: svg(`<circle cx="20" cy="20" r="15" fill="#f87" stroke="#f43" stroke-width="6"/>`)
  },
})

const lintGutterConfig = Facet.define<LintGutterConfig, Required<LintGutterConfig>>({
  combine(configs) {
    return combineConfig(configs, {
      hoverTime: Hover.Time,
      markerFilter: null,
      tooltipFilter: null
    });
  }
});

/// Returns an extension that installs a gutter showing markers for
/// each line that has diagnostics, which can be hovered over to see
/// the diagnostics.
export function lintGutter(config: LintGutterConfig = {}): Extension {
  return [lintGutterConfig.of(config), lintGutterMarkers, lintGutterExtension, lintGutterTheme, lintGutterTooltip]
}
