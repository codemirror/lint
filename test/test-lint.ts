import ist from "ist"
import {setDiagnostics, Diagnostic, forEachDiagnostic} from "@codemirror/lint"
import {EditorState} from "@codemirror/state"
import {EditorView, DecorationSet} from "@codemirror/view"

function w(from: number, to: number, msg?: string): Diagnostic {
  return {from, to, severity: "warning", message: msg || "warning"}
}
function e(from: number, to: number, msg?: string): Diagnostic {
  return {from, to, severity: "error", message: msg || "error"}
}

function istJSON(a: any, b: any) { ist(JSON.stringify(a), JSON.stringify(b)) }

function diagnostics(s: EditorState) {
  let found: Diagnostic[] = []
  forEachDiagnostic(s, (d, from, to) => found.push({...d, from, to}))
  return found
}

function state(ds: readonly Diagnostic[]) {
  let s = EditorState.create({doc: "0123456789"})
  return s.update(setDiagnostics(s, ds)).state
}

describe("lint", () => {
  it("can store diagnostics", () => {
    let ds = [w(0, 1), e(3, 4)]
    istJSON(diagnostics(state(ds)), ds)
  })

  it("can map diagnostics through changes", () => {
    let s = state([e(0, 2, "before"), w(3, 4), e(5, 7, "after")]).update({changes: {from: 2, to: 5}}).state
    istJSON(diagnostics(s), [e(0, 2, "before"), e(2, 4, "after")])
  })

  it("doesn't include new text in diagnostics", () => {
    let s = state([e(0, 2, "before"), e(2, 4, "after")]).update({changes: {from: 2, insert: "x"}}).state
    istJSON(diagnostics(s), [e(0, 2, "before"), e(3, 5, "after")])
  })

  it("properly stores overlapping diagnostics", () => {
    let ds = [e(3, 4, "c"), w(0, 5, "a"), e(0, 5, "b"), w(4, 8, "d")]
    istJSON(diagnostics(state(ds)), ds)
  })

  it("properly stores empty diagnostics", () => {
    let ds = [e(2, 2, "b"), e(2, 2, "c"), w(0, 5, "a"), w(5, 5, "d")]
    istJSON(diagnostics(state(ds)), ds)
  })

  it("doesn't create overlapping decorations", () => {
    let ds = [w(0, 5, "a"), e(0, 5, "b"), e(3, 4, "c"), w(4, 8, "d")]
    let deco = state(ds).facet(EditorView.decorations)[0] as DecorationSet
    let result: [number, number, string][] = []
    deco.between(0, 10, (from, to, val) => {
      result.push([from, to, /lintRange-(\w+)/.exec(val.spec.class)![1]])
    })
    istJSON(result, [[0, 3, "error"], [3, 4, "error"], [4, 5, "error"], [5, 8, "warning"]])
  })
})
