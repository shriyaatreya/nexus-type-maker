// Font registry. Every font is parsed with opentype.js (real glyph outlines,
// needed for vector export) and also registered as a CSS FontFace so the
// dropdown can preview it with native text rendering.

export const CATEGORIES = ['Italic serif', 'Script', 'Calligraphy', 'Serif', 'Sans & common', 'Uploaded'];

const BUILT_IN = [
  // Italic serifs — high contrast, like the reference
  { id: 'playfair', name: 'Playfair Display Italic', file: 'PlayfairDisplay-Italic.ttf', cat: 'Italic serif' },
  { id: 'cormorant', name: 'Cormorant Garamond Italic', file: 'CormorantGaramond-Italic.ttf', cat: 'Italic serif' },
  { id: 'bodoni', name: 'Bodoni Moda Italic', file: 'BodoniModa-Italic.ttf', cat: 'Italic serif' },
  { id: 'imfell', name: 'IM Fell English Italic', file: 'IMFellEnglish-Italic.ttf', cat: 'Italic serif' },
  // Libre Caslon Display has no italic on Google Fonts; Libre Caslon Text does.
  { id: 'caslon', name: 'Libre Caslon Text Italic', file: 'LibreCaslonText-Italic.ttf', cat: 'Italic serif' },
  { id: 'dmserif', name: 'DM Serif Display Italic', file: 'DMSerifDisplay-Italic.ttf', cat: 'Italic serif' },
  { id: 'instrument', name: 'Instrument Serif Italic', file: 'InstrumentSerif-Italic.ttf', cat: 'Italic serif' },
  { id: 'fraunces', name: 'Fraunces Italic', file: 'Fraunces-Italic.ttf', cat: 'Italic serif' },
  { id: 'ebgaramond', name: 'EB Garamond Italic', file: 'EBGaramond-Italic.ttf', cat: 'Italic serif' },
  { id: 'baskerville', name: 'Libre Baskerville Italic', file: 'LibreBaskerville-Italic.ttf', cat: 'Italic serif' },
  { id: 'lora', name: 'Lora Italic', file: 'Lora-Italic.ttf', cat: 'Italic serif' },
  // TeX Gyre Bonum: free (GUST license) recreation of ITC Bookman. The
  // commercial Bookman FONT Pro can be added with "Upload .ttf / .otf".
  { id: 'bonum-italic', name: 'TeX Gyre Bonum Italic (Bookman)', file: 'texgyrebonum-italic.otf', cat: 'Italic serif' },
  { id: 'bonum-bolditalic', name: 'TeX Gyre Bonum Bold Italic (Bookman)', file: 'texgyrebonum-bolditalic.otf', cat: 'Italic serif' },

  // Scripts & calligraphy
  { id: 'pinyon', name: 'Pinyon Script', file: 'PinyonScript-Regular.ttf', cat: 'Script' },
  { id: 'greatvibes', name: 'Great Vibes', file: 'GreatVibes-Regular.ttf', cat: 'Script' },
  { id: 'petit', name: 'Petit Formal Script', file: 'PetitFormalScript-Regular.ttf', cat: 'Script' },
  { id: 'italianno', name: 'Italianno', file: 'Italianno-Regular.ttf', cat: 'Script' },
  { id: 'doulaise', name: 'Monsieur La Doulaise', file: 'MonsieurLaDoulaise-Regular.ttf', cat: 'Script' },
  { id: 'allura', name: 'Allura', file: 'Allura-Regular.ttf', cat: 'Script' },
  { id: 'alexbrush', name: 'Alex Brush', file: 'AlexBrush-Regular.ttf', cat: 'Script' },
  { id: 'parisienne', name: 'Parisienne', file: 'Parisienne-Regular.ttf', cat: 'Script' },
  { id: 'tangerine', name: 'Tangerine Bold', file: 'Tangerine-Bold.ttf', cat: 'Script' },
  { id: 'dancing', name: 'Dancing Script', file: 'DancingScript.ttf', cat: 'Script' },
  { id: 'sacramento', name: 'Sacramento', file: 'Sacramento-Regular.ttf', cat: 'Script' },
  { id: 'delafield', name: 'Mrs Saint Delafield', file: 'MrsSaintDelafield-Regular.ttf', cat: 'Script' },
  { id: 'muellerhoff', name: 'Herr Von Muellerhoff', file: 'HerrVonMuellerhoff-Regular.ttf', cat: 'Script' },
  { id: 'corinthia', name: 'Corinthia', file: 'Corinthia-Regular.ttf', cat: 'Script' },
  { id: 'ballet', name: 'Ballet', file: 'Ballet.ttf', cat: 'Script' },
  { id: 'imperial', name: 'Imperial Script', file: 'ImperialScript-Regular.ttf', cat: 'Script' },
  { id: 'lavishly', name: 'Lavishly Yours', file: 'LavishlyYours-Regular.ttf', cat: 'Script' },
  { id: 'windsong', name: 'WindSong', file: 'WindSong-Medium.ttf', cat: 'Script' },
  { id: 'rouge', name: 'Rouge Script', file: 'RougeScript-Regular.ttf', cat: 'Script' },
  { id: 'carattere', name: 'Carattere', file: 'Carattere-Regular.ttf', cat: 'Script' },

  // Calligraphy: copperplate, brush and blackletter
  { id: 'ephesis', name: 'Ephesis', file: 'Ephesis-Regular.ttf', cat: 'Calligraphy' },
  { id: 'meaculpa', name: 'Mea Culpa', file: 'MeaCulpa-Regular.ttf', cat: 'Calligraphy' },
  { id: 'montecarlo', name: 'Monte Carlo', file: 'MonteCarlo-Regular.ttf', cat: 'Calligraphy' },
  { id: 'luxurious', name: 'Luxurious Script', file: 'LuxuriousScript-Regular.ttf', cat: 'Calligraphy' },
  { id: 'bilbo', name: 'Bilbo Swash Caps', file: 'BilboSwashCaps-Regular.ttf', cat: 'Calligraphy' },
  { id: 'qwigley', name: 'Qwigley', file: 'Qwigley-Regular.ttf', cat: 'Calligraphy' },
  { id: 'arizonia', name: 'Arizonia', file: 'Arizonia-Regular.ttf', cat: 'Calligraphy' },
  { id: 'euphoria', name: 'Euphoria Script', file: 'EuphoriaScript-Regular.ttf', cat: 'Calligraphy' },
  { id: 'engagement', name: 'Engagement', file: 'Engagement-Regular.ttf', cat: 'Calligraphy' },
  { id: 'bonheur', name: 'Bonheur Royale', file: 'BonheurRoyale-Regular.ttf', cat: 'Calligraphy' },
  { id: 'msmadi', name: 'Ms Madi', file: 'MsMadi-Regular.ttf', cat: 'Calligraphy' },
  { id: 'unifraktur', name: 'UnifrakturMaguntia (blackletter)', file: 'UnifrakturMaguntia-Book.ttf', cat: 'Calligraphy' },
  { id: 'pirata', name: 'Pirata One (blackletter)', file: 'PirataOne-Regular.ttf', cat: 'Calligraphy' },

  // Upright serifs
  { id: 'bonum', name: 'TeX Gyre Bonum (Bookman)', file: 'texgyrebonum-regular.otf', cat: 'Serif' },
  { id: 'abril', name: 'Abril Fatface', file: 'AbrilFatface-Regular.ttf', cat: 'Serif' },
  { id: 'gloock', name: 'Gloock', file: 'Gloock-Regular.ttf', cat: 'Serif' },
  { id: 'prata', name: 'Prata', file: 'Prata-Regular.ttf', cat: 'Serif' },
  { id: 'italiana', name: 'Italiana', file: 'Italiana-Regular.ttf', cat: 'Serif' },
  { id: 'tinos', name: 'Tinos (Times-style)', file: 'Tinos-Regular.ttf', cat: 'Serif' },

  // Everyday sans & display
  { id: 'inter', name: 'Inter', file: 'Inter.ttf', cat: 'Sans & common' },
  { id: 'arimo', name: 'Arimo (Helvetica/Arial-style)', file: 'Arimo.ttf', cat: 'Sans & common' },
  { id: 'roboto', name: 'Roboto', file: 'Roboto.ttf', cat: 'Sans & common' },
  { id: 'opensans', name: 'Open Sans', file: 'OpenSans.ttf', cat: 'Sans & common' },
  { id: 'lato', name: 'Lato', file: 'Lato-Regular.ttf', cat: 'Sans & common' },
  { id: 'montserrat', name: 'Montserrat', file: 'Montserrat.ttf', cat: 'Sans & common' },
  { id: 'poppins', name: 'Poppins SemiBold', file: 'Poppins-SemiBold.ttf', cat: 'Sans & common' },
  { id: 'spacegrotesk', name: 'Space Grotesk', file: 'SpaceGrotesk.ttf', cat: 'Sans & common' },
  { id: 'oswald', name: 'Oswald', file: 'Oswald.ttf', cat: 'Sans & common' },
  { id: 'bebas', name: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', cat: 'Sans & common' },
  { id: 'archivoblack', name: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf', cat: 'Sans & common' },
];

export const fonts = BUILT_IN.map((f) => ({ ...f, url: `fonts/${f.file}`, font: null }));

export const cssFamily = (entry) => `HT-${entry.id}`;

const pending = new Map();

// Registered but not loaded: the browser fetches each face only when the
// dropdown actually renders text in it.
export function registerPreviews() {
  for (const entry of fonts) {
    document.fonts.add(new FontFace(cssFamily(entry), `url("${entry.url}")`));
  }
}

export function getFont(entry) {
  if (entry.font) return Promise.resolve(entry.font);
  if (!pending.has(entry.id)) {
    const p = fetch(entry.url)
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load ${entry.name}`);
        return r.arrayBuffer();
      })
      .then((buf) => (entry.font = opentype.parse(buf)));
    pending.set(entry.id, p);
  }
  return pending.get(entry.id);
}

let customCount = 0;

export async function addCustomFont(file) {
  const buf = await file.arrayBuffer();
  let font;
  try {
    font = opentype.parse(buf);
  } catch (err) {
    throw new Error(`Couldn’t read ${file.name}: ${err.message}`);
  }
  const name =
    font.names.fullName?.en ||
    font.names.fontFamily?.en ||
    file.name.replace(/\.(ttf|otf)$/i, '');
  const entry = { id: `custom-${++customCount}`, name, url: null, font, custom: true, cat: 'Uploaded' };
  const face = new FontFace(cssFamily(entry), buf);
  document.fonts.add(face);
  await face.load().catch(() => {});
  fonts.push(entry);
  return entry;
}
