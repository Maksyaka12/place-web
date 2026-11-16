import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, Menu, Search, X } from 'lucide-react';
import { Badge, Button } from '../../components/ui';
import { ThemeSwitcher } from '../../components/ThemeSwitcher';
import { THEMES, getTheme, setTheme } from '../../../../theme';
import { DOC_GROUPS, DOC_PAGES } from './pages';

// /docs and /docs/<page>: the Place documentation. A standalone page with its own menu instead of the app
// shell. The content lives in ./pages, one file per menu group; a page is { slug, title, lead, sections }.

const SEARCH_INDEX = DOC_PAGES.flatMap((page) => [
  { page, id: null, label: page.title, text: `${page.title} ${page.lead}`.toLowerCase() },
  ...page.sections.filter((s) => s.title).map((s) => ({ page, id: s.id, label: s.title, text: `${s.title} ${page.title}`.toLowerCase() })),
]);

function DocsSearch({ onNavigate, shortcut = false }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const input = useRef(null);
  const q = query.trim().toLowerCase();
  const results = useMemo(() => (q ? SEARCH_INDEX.filter((r) => r.text.includes(q)).slice(0, 8) : []), [q]);

  useEffect(() => {
    if (!shortcut) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcut]);

  const pick = () => {
    setQuery('');
    onNavigate?.();
  };

  return (
    <div className="pl-docs-search" onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
      <Search size={15} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search the docs"
        aria-label="Search the docs"
      />
      {shortcut && !query && <kbd className="mono">Ctrl K</kbd>}
      {focused && q && (
        <div className="pl-docs-search-results">
          {results.length === 0 && <div className="pl-docs-search-empty">Nothing found for this search. Try a shorter word.</div>}
          {results.map((r) => (
            <Link key={`${r.page.slug}-${r.id}`} to={`/docs${r.page.slug ? `/${r.page.slug}` : ''}${r.id ? `#${r.id}` : ''}`} onClick={pick}>
              <b>{r.label}</b>
              {r.id && <span>{r.page.title}</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function DocsNav({ onNavigate }) {
  const currentTheme = getTheme();
  return (
    <div className="pl-docs-nav-list" role="navigation" aria-label="Documentation">
      {DOC_GROUPS.map((group) => (
        <div key={group.title} className="pl-docs-nav-group">
          <div className="pl-docs-nav-label">{group.title}</div>
          {group.pages.map((page) => (
            <NavLink key={page.slug} to={`/docs${page.slug ? `/${page.slug}` : ''}`} end onClick={onNavigate} className={({ isActive }) => (isActive ? 'active' : undefined)}>
              {page.title}
            </NavLink>
          ))}
        </div>
      ))}
      <div className="pl-docs-nav-theme">
        <span>Theme</span>
        <div className="seg" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={t.id === currentTheme} aria-selected={t.id === currentTheme} onClick={() => setTheme(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// "On this page": follows the section being read.
function DocsToc({ page }) {
  const sections = page.sections.filter((s) => s.title);
  const [current, setCurrent] = useState(sections[0]?.id);

  useEffect(() => {
    setCurrent(sections[0]?.id);
    const onScroll = () => {
      const line = 120;
      let active = sections[0]?.id;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= line) active = s.id;
      }
      setCurrent(active);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  if (sections.length < 2) return null;
  return (
    <aside className="pl-docs-toc" aria-label="On this page">
      <div className="pl-docs-toc-label">On this page</div>
      {sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} className={current === s.id ? 'active' : undefined}>{s.title}</a>
      ))}
    </aside>
  );
}

function PrevNext({ index }) {
  const prev = DOC_PAGES[index - 1];
  const next = DOC_PAGES[index + 1];
  const href = (p) => `/docs${p.slug ? `/${p.slug}` : ''}`;
  return (
    <div className="pl-docs-prevnext">
      {prev ? (
        <Link to={href(prev)}>
          <span><ArrowLeft size={14} /> Previous</span>
          <b>{prev.title}</b>
        </Link>
      ) : <i />}
      {next ? (
        <Link to={href(next)} className="next">
          <span>Next <ArrowRight size={14} /></span>
          <b>{next.title}</b>
        </Link>
      ) : <i />}
    </div>
  );
}

export default function DocsPage() {
  const { slug = '' } = useParams();
  const { hash } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const index = DOC_PAGES.findIndex((p) => p.slug === slug);
  const page = DOC_PAGES[index];
  const group = page && DOC_GROUPS.find((g) => g.pages.includes(page));

  useEffect(() => {
    if (!page) return undefined;
    document.title = page.slug ? `${page.title} · Place docs` : 'Place docs';
    return () => {
      document.title = 'Place';
    };
  }, [page]);

  // A link to a section lands on it; a link to a page starts at its top.
  useEffect(() => {
    if (!page) return;
    const el = hash && document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [page, hash]);

  if (!page) return <Navigate to="/docs" replace />;

  return (
    <div className="base-app-shell pl-docs">
      <header className="pl-docs-bar">
        <button type="button" className="pl-docs-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open docs menu">
          <Menu size={20} strokeWidth={1.75} />
        </button>
        <Link to="/docs" className="pl-docs-brand">
          <img src="/logo.png" alt="" />
          <span className="pl-brand">Place</span>
          <Badge tone="accent">Docs</Badge>
        </Link>
        <div className="pl-docs-bar-search"><DocsSearch shortcut /></div>
        <div className="pl-docs-bar-right">
          <ThemeSwitcher />
          <Button as={Link} to="/" variant="primary" size="sm">
            Open app <ArrowUpRight size={14} />
          </Button>
        </div>
      </header>

      <div className="pl-docs-body">
        {menuOpen && <div className="pl-docs-backdrop" onClick={() => setMenuOpen(false)} />}
        <aside className={`pl-docs-nav ${menuOpen ? 'open' : ''}`.trim()}>
          <div className="pl-docs-nav-mobile-head">
            <DocsSearch onNavigate={() => setMenuOpen(false)} />
            <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close docs menu">
              <X size={18} strokeWidth={1.75} />
            </button>
          </div>
          <DocsNav onNavigate={() => setMenuOpen(false)} />
        </aside>

        <div className="pl-docs-main">
          <main key={page.slug} className="pl-docs-article">
            <div className="pl-docs-eyebrow">{group.title}</div>
            <h1 className="page-title">{page.title}</h1>
            <p className="pl-docs-lead">{page.lead}</p>
            {page.sections.map((s, i) => (
              <section key={s.id || i} className="pl-docs-section">
                {s.title && <h2 id={s.id} className="pl-docs-h2"><a href={`#${s.id}`}>{s.title}</a></h2>}
                {s.body}
              </section>
            ))}
            <PrevNext index={index} />
          </main>
          <DocsToc page={page} />
        </div>
      </div>
    </div>
  );
}
