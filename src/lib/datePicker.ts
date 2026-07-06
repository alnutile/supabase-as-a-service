// Reliably open a native `<input type="date">` picker.
//
// The To-dos due-date control overlays a transparent date input on a pill and
// used to rely on the browser's default click-to-open behavior. That's flaky —
// Chromium in particular *toggles* the picker on click (and skips opening when
// the input just gained focus, or after a prior interaction), which is why the
// popup "sometimes doesn't show, sometimes a reload fixes it, sometimes one
// works then the next doesn't". Calling `showPicker()` from the click handler
// makes it deterministic.
//
// `showPicker()` is guarded because it isn't supported on older browsers and
// throws if called outside a user gesture (or in a cross-origin frame); in
// those cases we fall back to the browser's native behavior. Returns whether
// the picker was opened programmatically.
export function openDatePicker(el: Pick<HTMLInputElement, 'showPicker'> | null | undefined): boolean {
  if (!el || typeof el.showPicker !== 'function') return false
  try {
    el.showPicker()
    return true
  } catch {
    return false
  }
}
