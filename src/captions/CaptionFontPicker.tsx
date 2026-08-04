// Font list for the caption style menu. The caption style model already carries
// fontFamily (CaptionStyleOverride) and the render/export path already collects
// caption faces (projectFonts.collectReferencedFontFaces), so picking here is
// enough for both preview and export — no extra wiring needed.
import { useEffect, useMemo, useState } from 'react';
import { FONT_CATALOG, searchFontCatalog, type FontSearchHit } from '../fonts/googleFontCatalog';
import { ensureFont } from '../fonts/googleFonts';
import { useT } from '../i18n/locale';

/** Rows previewed at once; also the search cap. Keeps font loading bounded. */
const MAX_ROWS = 40;

interface CaptionFontPickerProps {
  /** Family currently rendered (template default, or the override when set). */
  current: string | undefined;
  /** True when the caption carries an explicit fontFamily override. */
  overridden: boolean;
  onPick: (family: string) => void;
  /** Drop the override and fall back to the template's own face. */
  onClear: () => void;
}

export function CaptionFontPicker({ current, overridden, onPick, onClear }: CaptionFontPickerProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  // searchFontCatalog returns nothing for an empty query, so the unsearched
  // state lists the whole catalog instead of going blank.
  const hits = useMemo<FontSearchHit[]>(
    () => (query.trim()
      ? searchFontCatalog(query, MAX_ROWS)
      : FONT_CATALOG.slice(0, MAX_ROWS).map((entry) => ({ ...entry }))),
    [query],
  );

  // Load every listed face so each row previews in its real typeface rather
  // than the panel's fallback.
  useEffect(() => {
    for (const hit of hits) void ensureFont(hit.family).catch(() => {});
  }, [hits]);

  return (
    <div className="cc-caption-font-picker">
      <input
        className="cc-caption-font-search"
        value={query}
        placeholder={t('搜索字体...')}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="cc-caption-font-list">
        <button type="button" className={overridden ? '' : 'active'} onClick={onClear}>
          <span className="cc-caption-style-swatch">Aa</span>
          <span>{t('跟随模板')}</span>
        </button>
        {hits.map((hit) => (
          <button
            type="button"
            key={hit.family}
            className={overridden && current === hit.family ? 'active' : ''}
            title={hit.aliases.length ? `${hit.family} · ${hit.aliases.join(' / ')}` : hit.family}
            onClick={() => onPick(hit.family)}
          >
            <span className="cc-caption-style-swatch" style={{ fontFamily: `'${hit.family}'` }}>Aa</span>
            <span className="cc-caption-font-name" style={{ fontFamily: `'${hit.family}'` }}>{hit.family}</span>
            {hit.source === 'bundled' && <span className="cc-caption-font-tag">{t('内置')}</span>}
          </button>
        ))}
        {!hits.length && <div className="cc-caption-font-empty">{t('没有匹配的字体')}</div>}
      </div>
    </div>
  );
}
