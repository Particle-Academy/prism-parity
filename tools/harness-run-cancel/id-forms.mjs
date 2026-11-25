// The run id forms every runner derives identically from the LIVE run id.
// PHP: HarnessRunCancelTest::form(); Python: runner.py id_form(). Run ids are
// ASCII in every port, so these character operations agree byte for byte.
const LOOKALIKE = { a: 'а', c: 'с', e: 'е' };

function homoglyph(real) {
  let best = -1;
  for (const ascii of Object.keys(LOOKALIKE)) {
    const at = real.indexOf(ascii);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best === -1 ? `${real}а` : real.slice(0, best) + LOOKALIKE[real[best]] + real.slice(best + 1);
}

export function idForm(form, real, previous) {
  const last = real.slice(-1);
  switch (form) {
    case 'current': return real;
    case 'previous': if (previous === null) throw Error('No previous run id.'); return previous;
    case 'forged': return real.slice(0, -1) + (last === '0' ? '1' : '0');
    case 'empty': return '';
    case 'truncated': return real.slice(0, -1);
    case 'extended': return real + last;
    case 'traversal': return `../${real}`;
    case 'upper': return real.toUpperCase();
    case 'trailing_newline': return `${real}\n`;
    case 'trailing_space': return `${real} `;
    case 'leading_space': return ` ${real}`;
    case 'zero_width': return `${real}​`;
    case 'nbsp': return `${real} `;
    case 'nul': return `${real}\u0000`;
    case 'homoglyph': return homoglyph(real);
    default: throw Error(`Unknown id form ${form}`);
  }
}
