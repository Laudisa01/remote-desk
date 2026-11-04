// Übersetzt KeyboardEvent.code / .key aus dem Browser in nut-js-Tastennamen.
// Mehrere Kandidaten, weil sich Namen zwischen nut-js-Versionen leicht unterscheiden.

const CODE_MAP = {
  Enter: ['Enter', 'Return'], NumpadEnter: ['Enter', 'Return'],
  Escape: ['Escape'], Backspace: ['Backspace'], Tab: ['Tab'], Space: ['Space'],
  Minus: ['Minus'], Equal: ['Equal'], BracketLeft: ['LeftBracket'], BracketRight: ['RightBracket'],
  Backslash: ['Backslash'], Semicolon: ['Semicolon'], Quote: ['Quote'], Backquote: ['Grave'],
  Comma: ['Comma'], Period: ['Period'], Slash: ['Slash'], IntlBackslash: ['Backslash'],
  CapsLock: ['CapsLock'], PrintScreen: ['Print'], ScrollLock: ['ScrollLock'], Pause: ['Pause'],
  Insert: ['Insert'], Home: ['Home'], PageUp: ['PageUp'], Delete: ['Delete'], End: ['End'], PageDown: ['PageDown'],
  ArrowRight: ['Right'], ArrowLeft: ['Left'], ArrowDown: ['Down'], ArrowUp: ['Up'],
  NumLock: ['NumLock'], NumpadDivide: ['Divide'], NumpadMultiply: ['Multiply'], NumpadSubtract: ['Subtract'],
  NumpadAdd: ['Add'], NumpadDecimal: ['Decimal'],
  ControlLeft: ['LeftControl'], ControlRight: ['RightControl'],
  ShiftLeft: ['LeftShift'], ShiftRight: ['RightShift'],
  AltLeft: ['LeftAlt'], AltRight: ['RightAlt'],
  MetaLeft: ['LeftSuper', 'LeftWin', 'LeftCmd'], MetaRight: ['RightSuper', 'RightWin', 'RightCmd'],
  OSLeft: ['LeftSuper', 'LeftWin', 'LeftCmd'], OSRight: ['RightSuper', 'RightWin', 'RightCmd'],
  ContextMenu: ['Menu'],
  AudioVolumeMute: ['AudioMute'], AudioVolumeDown: ['AudioVolDown'], AudioVolumeUp: ['AudioVolUp'],
  MediaPlayPause: ['AudioPlay', 'AudioPause'], MediaTrackNext: ['AudioNext'], MediaTrackPrevious: ['AudioPrev'],
};
for (let i = 0; i <= 9; i++) {
  CODE_MAP[`Digit${i}`] = [`Num${i}`];
  CODE_MAP[`Numpad${i}`] = [`NumPad${i}`];
}
for (let i = 1; i <= 24; i++) CODE_MAP[`F${i}`] = [`F${i}`];
for (let c = 65; c <= 90; c++) {
  const ch = String.fromCharCode(c);
  CODE_MAP[`Key${ch}`] = [ch];
}

function pick(Key, names) {
  for (const n of names) if (Key[n] !== undefined) return Key[n];
  return undefined;
}

/** Liefert den nut-js Key-Wert oder undefined. */
function resolveKey(Key, code, key) {
  // Bei Buchstaben mit Strg/Cmd lieber das Zeichen nehmen (z. B. Strg+Z auf deutscher Tastatur)
  if (key && key.length === 1 && /[a-z]/i.test(key)) {
    const v = pick(Key, [key.toUpperCase()]);
    if (v !== undefined) return v;
  }
  if (CODE_MAP[code]) return pick(Key, CODE_MAP[code]);
  return undefined;
}

/** Name wie "LeftAlt" (aus Tastenkombinationen der Toolbar) auflösen. */
function resolveName(Key, name) {
  const alts = {
    LeftSuper: ['LeftSuper', 'LeftWin', 'LeftCmd'],
    Escape: ['Escape'],
  };
  return pick(Key, alts[name] || [name]);
}

module.exports = { resolveKey, resolveName };
