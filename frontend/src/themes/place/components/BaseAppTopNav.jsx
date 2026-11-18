// The app's top navigation: logo with the product menu, main sections, token search, Launch NFT and Launch token,
// theme and wallet.
// Below 1024 px the sections and the product menu move into one sheet opened from the menu button.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight,
  BadgeCheck,
  BookOpen,
  Boxes,
  ChevronDown,
  Coins,
  Gift,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  Menu,
  Plus,
  PlusCircle,
  Puzzle,
  Search,
  Shield,
  Sparkles,
  UserRound,
  Wallet,
  X,
} from 'lucide-react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useAccount, useDisconnect } from 'wagmi';
import WalletMenu from '../../../components/wallet/WalletMenu';
import { PLACE_CHAIN } from '../../../place/chain';
import { shortAddress } from '../../../place/format';
import { isPlaceAdmin } from '../../../place/moderation';
import { ThemeSwitcher } from './ThemeSwitcher';
import { THEMES, getTheme, setTheme } from '../../../theme';
import WalletToggle from '../../../components/wallet/WalletToggle';
import AgentsButton from '../../../components/agent/AgentsButton';
import { usePlaceWallets } from '../../../hooks/usePlaceWallets';
import { FEATURES } from '../../../config/features';
import { launchTokenPath } from '../../../launch/ui/parts.jsx';

/** Main sections in the top bar. `section` is what BaseAppView reports as active. */
export const NAV_SECTIONS = [
  { section: 'dashboard', label: 'Dashboard', to: '/', Icon: LayoutGrid },
  { section: 'stocks', label: 'Stocks', to: '/stocks', Icon: LineChart },
  { section: 'profile', label: 'Profile', to: '/profile', Icon: UserRound },
  { section: 'hub', label: 'Rewards', to: '/hub', Icon: Gift },
  { section: 'projects', label: 'Projects', to: '/projects', Icon: Boxes },
];

/** Everything else, in the product menu next to the logo. */
const MORE_LINKS = [
  { label: 'My rewards', to: '/profile/rewards', Icon: Gift },
  { label: 'Staking', to: '/hub?type=staking', Icon: Coins },
  { label: 'Create vault / campaign', to: '/create', Icon: PlusCircle },
  { label: 'Launch NFT', to: '/launch/nft', Icon: Sparkles },
  { label: 'My launches', to: '/profile/launches', Icon: LayoutDashboard },
  { label: 'Register token', to: '/projects/register', Icon: BadgeCheck },
  { label: 'Wallet', to: '/wallet', Icon: Wallet },
  { label: 'Swap', to: '/swap', Icon: ArrowLeftRight },
  ...(FEATURES.agents ? [{ label: 'Skill', to: '/skill', Icon: Puzzle }] : []),
  { label: 'Docs', to: '/docs', Icon: BookOpen },
];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Closes a popover on an outside click or Escape. */
function useDismiss(open, setOpen) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);
  return ref;
}

function TokenSearch({ onDone }) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  // "/" focuses the search from anywhere, as long as the user isn't typing somewhere else.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const submit = (e) => {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    navigate(ADDRESS.test(q) ? launchTokenPath(q) : `/?q=${encodeURIComponent(q)}`);
    setValue('');
    inputRef.current?.blur();
    onDone?.();
  };

  return (
    <form className="pl-topnav-search" role="search" onSubmit={submit}>
      <Search size={16} aria-hidden="true" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by name, symbol, or address"
        aria-label="Search tokens"
      />
      <kbd aria-hidden="true">/</kbd>
    </form>
  );
}

function ProductMenu({ isAdmin }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, setOpen);
  return (
    <div ref={ref} className="pl-topnav-product">
      <Link to="/" className="pl-topnav-logo" aria-label="Place, dashboard">
        <img src="/logo.svg" alt="" width="28" height="28" />
        <span>Place</span>
      </Link>
      <button
        type="button"
        className="pl-topnav-product-toggle"
        aria-label="More pages"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="pl-topnav-menu" role="menu">
          {MORE_LINKS.map(({ label, to, Icon }) => (
            <Link key={to} to={to} role="menuitem" className="pl-topnav-menu-item" onClick={() => setOpen(false)}>
              <Icon size={16} strokeWidth={1.75} />
              {label}
            </Link>
          ))}
          {isAdmin && (
            <Link to="/admin" role="menuitem" className="pl-topnav-menu-item" onClick={() => setOpen(false)}>
              <Shield size={16} strokeWidth={1.75} />
              Admin
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** The phone sheet: sections, search, the product menu and the theme. */
function MobileSheet({ activeSection, isAdmin, onClose }) {
  const current = getTheme();
  return (
    <div className="pl-topnav-sheet-overlay" onClick={onClose}>
      <div className="pl-topnav-sheet" role="dialog" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
        <div className="pl-topnav-sheet-head">
          <span>Menu</span>
          <button type="button" className="pl-topnav-icon-btn" aria-label="Close menu" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <TokenSearch onDone={onClose} />
        <nav className="pl-topnav-sheet-list" aria-label="Sections">
          {NAV_SECTIONS.map(({ section, label, to, Icon }) => (
            <Link
              key={to}
              to={to}
              className="pl-topnav-menu-item"
              aria-current={activeSection === section ? 'page' : undefined}
              onClick={onClose}
            >
              <Icon size={18} strokeWidth={1.75} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="pl-topnav-sheet-list">
          {MORE_LINKS.map(({ label, to, Icon }) => (
            <Link key={to} to={to} className="pl-topnav-menu-item" onClick={onClose}>
              <Icon size={18} strokeWidth={1.75} />
              {label}
            </Link>
          ))}
          {isAdmin && (
            <Link to="/admin" className="pl-topnav-menu-item" onClick={onClose}>
              <Shield size={18} strokeWidth={1.75} />
              Admin
            </Link>
          )}
        </div>
        <div className="seg soft pl-topnav-sheet-theme" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-selected={t.id === current} aria-checked={t.id === current} onClick={() => setTheme(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BaseAppTopNav({ activeSection, isDesktop }) {
  const { login, logout, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { address: wagmiAddress, isConnected: isWagmiConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { activeAddress: placeActiveAddress } = usePlaceWallets();
  const activeAddress = placeActiveAddress || wallets?.[0]?.address || wagmiAddress;
  const hasWallet = (authenticated && !!activeAddress) || (isWagmiConnected && !!wagmiAddress);
  const isAdmin = hasWallet && isPlaceAdmin(activeAddress);
  const navigate = useNavigate();
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (isDesktop) setSheetOpen(false);
  }, [isDesktop]);

  return (
    <header className="pl-topnav">
      <div className="pl-topnav-inner">
        <ProductMenu isAdmin={isAdmin} />

        {isDesktop && (
          <nav className="pl-topnav-links" aria-label="Sections">
            {NAV_SECTIONS.map(({ section, label, to, Icon }) => (
              <Link key={to} to={to} className="pl-topnav-link" aria-current={activeSection === section ? 'page' : undefined}>
                <Icon size={16} strokeWidth={1.75} />
                {label}
              </Link>
            ))}
          </nav>
        )}

        {isDesktop && <TokenSearch />}

        <div className="pl-topnav-right">
          {isDesktop && (
            <button type="button" className="btn btn-secondary pl-topnav-launch pl-topnav-nft" onClick={() => navigate('/launch/nft')} aria-label="Launch NFT" title="Launch NFT">
              <Sparkles size={15} />
              <span>Launch NFT</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary pl-topnav-launch"
            onClick={() => navigate('/launch/new')}
            aria-label="Launch token"
          >
            <Plus size={16} />
            {isDesktop && <span>Launch token</span>}
          </button>
          {FEATURES.agents && <AgentsButton theme="dark" />}
          {FEATURES.agents && hasWallet && <WalletToggle theme="dark" size="sm" />}
          {isDesktop && <ThemeSwitcher />}
          {hasWallet ? (
            <WalletMenu
              theme="dark"
              onSelect={(page) => navigate(`/${page}`)}
              onLogout={() => {
                disconnect?.();
                logout?.();
              }}
              trigger={(toggle, open) => (
                <button
                  type="button"
                  className="pl-pill pl-place-address-pill"
                  title={activeAddress}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  <span className="pl-place-chain-dot" aria-hidden="true" />
                  <span className="mono">{shortAddress(activeAddress)}</span>
                  {isDesktop && <span className="pl-place-chain-name">{PLACE_CHAIN.name}</span>}
                  <ChevronDown size={14} />
                </button>
              )}
            />
          ) : (
            <button type="button" onClick={login} className="btn btn-secondary pl-topnav-connect">
              <Wallet size={16} strokeWidth={1.75} />
              <span>{isDesktop ? 'Connect wallet' : 'Connect'}</span>
            </button>
          )}
          {!isDesktop && (
            <button type="button" className="pl-topnav-icon-btn" aria-label="Open menu" onClick={() => setSheetOpen(true)}>
              <Menu size={20} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>
      {sheetOpen && <MobileSheet activeSection={activeSection} isAdmin={isAdmin} onClose={() => setSheetOpen(false)} />}
    </header>
  );
}
