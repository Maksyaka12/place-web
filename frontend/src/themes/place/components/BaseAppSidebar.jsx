import { useState } from 'react';
import {
  X,
  BookOpen,
  Puzzle,
  Gift,
  Compass,
  PlusCircle,
  LayoutDashboard,
  LogOut,
  Wallet,
  Check,
  Copy,
  ArrowLeftRight,
  ChevronDown,
  Shield,
  ChevronUp,
  Rocket,
  Plus,
  UserRound,
  Coins,
  Boxes,
} from 'lucide-react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useAccount, useDisconnect } from 'wagmi';
import { usePlaceWallets } from '../../../hooks/usePlaceWallets';
import { FEATURES } from '../../../config/features';
import WalletMenu from '../../../components/wallet/WalletMenu';
import { isPlaceAdmin } from '../../../place/moderation';

const shortAddress = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

const SidebarToggleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="3" ry="3" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

export function BaseAppSidebar({
  isOpen,
  onClose,
  activeTab,
  onSelectTab,
  isCollapsed = false,
  onToggleCollapse,
  isDesktop = false
}) {
  const { login, logout, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { address: wagmiAddress, isConnected: isWagmiConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [copied, setCopied] = useState(false);

  const [isAppMenuOpen, setIsAppMenuOpen] = useState(true);
  const [isDocsOpen, setIsDocsOpen] = useState(true);
  const [isToolsOpen, setIsToolsOpen] = useState(true);
  const [isLaunchOpen, setIsLaunchOpen] = useState(true);

  const { activeAddress: placeActiveAddress, mainAddress, hasAgentWallet, active } = usePlaceWallets();
  const activeAddress = placeActiveAddress || wallets?.[0]?.address || wagmiAddress;
  const hasWallet = (authenticated && !!activeAddress) || (isWagmiConnected && !!wagmiAddress);
  const adminAddress = mainAddress || activeAddress;
  const isAdmin = hasWallet && isPlaceAdmin(adminAddress);

  const selectFromMenu = (tab) => {
    onSelectTab(tab);
    if (!isDesktop) onClose();
  };

  const handleCopy = () => {
    if (!activeAddress) return;
    navigator.clipboard.writeText(activeAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDisconnect = () => {
    disconnect?.();
    logout?.();
    if (!isDesktop) onClose();
  };

  if (!isDesktop && !isOpen) return null;

  const appMenuItems = [
    { id: 'explore', name: 'Explore', icon: <Compass size={18} strokeWidth={1.75} /> },
    { id: 'rewards', name: 'My rewards', icon: <Gift size={18} strokeWidth={1.75} /> },
    { id: 'create', name: 'Create', icon: <PlusCircle size={18} strokeWidth={1.75} /> },
    { id: 'mine', name: 'My campaigns', icon: <LayoutDashboard size={18} strokeWidth={1.75} /> },
    { id: 'staking', name: 'Staking', icon: <Coins size={18} strokeWidth={1.75} /> },
    { id: 'projects', name: 'Projects', icon: <Boxes size={18} strokeWidth={1.75} /> },
    { id: 'wallet', name: 'Wallet', icon: <Wallet size={18} strokeWidth={1.75} /> },
    { id: 'buy', name: 'Swap', icon: <ArrowLeftRight size={18} strokeWidth={1.75} /> }
  ];

  const launchItems = [
    { id: 'launch', name: 'Launchpad', icon: <Rocket size={18} strokeWidth={1.75} /> },
    { id: 'launch-new', name: 'Launch token', icon: <Plus size={18} strokeWidth={1.75} /> },
    { id: 'launch-profile', name: 'Creator console', icon: <UserRound size={18} strokeWidth={1.75} /> }
  ];

  const toolsItems = FEATURES.agents ? [{ id: 'skill', name: 'Skill', icon: <Puzzle size={18} strokeWidth={1.75} /> }] : [];

  const docsItems = [
    { id: 'docs', name: 'Docs', icon: <BookOpen size={18} strokeWidth={1.75} /> }
  ];

  const sidebarWidth = isDesktop ? (isCollapsed ? '64px' : '248px') : '260px';

  return (
    <>
      {/* Mobile Backdrop */}
      {!isDesktop && isOpen && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            zIndex: 999998,
            transition: 'opacity 0.15s ease'
          }}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`base-app-sidebar ${isDesktop ? (isCollapsed ? 'collapsed' : 'expanded') : 'mobile-drawer'}`}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: sidebarWidth,
          maxWidth: isDesktop ? 'none' : '85vw',
          height: '100vh',
          background: 'var(--bg-bar)',
          borderRight: '1px solid var(--border)',
          zIndex: isDesktop ? 60 : 999999,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: isCollapsed ? '12px 8px' : '12px',
          boxSizing: 'border-box',
          fontFamily: 'var(--font-sans)',
          transition: isDesktop ? 'width 0.2s ease, padding 0.2s ease' : 'none',
          overflowY: 'auto',
          overflowX: 'hidden'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Header: 12px sidebar padding + 56px = 68px, so its bottom border lines up with the 68px top bar */}
          <div
            style={{
              height: '56px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: isCollapsed ? 'center' : 'space-between',
              padding: isCollapsed ? '0' : '0 4px',
              borderBottom: '1px solid var(--border)',
              marginBottom: '12px',
              boxSizing: 'border-box'
            }}
          >
            {isCollapsed ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                <img
                  src="/logo.svg"
                  alt="Place"
                  onClick={() => onSelectTab('explore')}
                  style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '8px',
                    objectFit: 'cover',
                    border: '1px solid var(--border)',
                    cursor: 'pointer'
                  }}
                />
                {onToggleCollapse && (
                  <button
                    onClick={onToggleCollapse}
                    title="Expand sidebar"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-3)',
                      cursor: 'pointer',
                      padding: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '6px'
                    }}
                  >
                    <SidebarToggleIcon />
                  </button>
                )}
              </div>
            ) : (
              <>
                <div
                  onClick={() => {
                    onSelectTab('explore');
                    if (!isDesktop) onClose();
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
                >
                  <img
                    src="/logo.svg"
                    alt="Place"
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '8px',
                      objectFit: 'cover',
                      border: '1px solid var(--border)'
                    }}
                  />
                  <span
                    className="pl-brand"
                    style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: '16px',
                      fontWeight: 800,
                      color: 'var(--text)',
                      letterSpacing: '-0.02em',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    Place
                  </span>
                </div>

                {isDesktop ? (
                  <button
                    onClick={onToggleCollapse}
                    title="Collapse sidebar"
                    aria-label="Toggle sidebar"
                    style={{
                      width: '32px',
                      height: '32px',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: '8px',
                      color: 'var(--text-3)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'color 0.15s ease, background 0.15s ease'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'var(--text)';
                      e.currentTarget.style.background = 'var(--surface-2)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--text-3)';
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <SidebarToggleIcon />
                  </button>
                ) : (
                  <button
                    onClick={onClose}
                    aria-label="Close menu"
                    style={{
                      width: '32px',
                      height: '32px',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: '8px',
                      color: 'var(--text-2)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    <X size={18} strokeWidth={1.75} />
                  </button>
                )}
              </>
            )}
          </div>

          {/* Section 1: App menu */}
          <div style={{ marginBottom: '8px' }}>
            {!isCollapsed && (
              <div
                onClick={() => setIsAppMenuOpen(!isAppMenuOpen)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 8px 6px',
                  cursor: 'pointer',
                  userSelect: 'none'
                }}
              >
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--text-3)'
                  }}
                >
                  Navigation
                </span>
                <ChevronDown
                  size={14}
                  color="var(--text-3)"
                  style={{
                    transform: isAppMenuOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                    transition: 'transform 0.15s ease'
                  }}
                />
              </div>
            )}

            {(isCollapsed || isAppMenuOpen) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {appMenuItems.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      title={item.name}
                      onClick={() => {
                        onSelectTab(item.id);
                        if (!isDesktop) onClose();
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: isCollapsed ? 'center' : 'flex-start',
                        gap: '10px',
                        width: '100%',
                        height: '40px',
                        padding: isCollapsed ? '0' : '0 10px',
                        borderRadius: '10px',
                        border: 'none',
                        background: isActive ? 'var(--accent-soft)' : 'transparent',
                        color: isActive ? 'var(--accent)' : 'var(--text-2)',
                        fontSize: '14px',
                        fontWeight: 500,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'var(--font-sans)',
                        transition: 'background 0.15s ease, color 0.15s ease'
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'var(--surface-2)';
                          e.currentTarget.style.color = 'var(--text)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.color = 'var(--text-2)';
                        }
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', color: isActive ? 'var(--accent)' : 'currentColor' }}>
                        {item.icon}
                      </span>
                      {!isCollapsed && (
                        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.name}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Section: Launchpad */}
          <div style={{ marginBottom: '8px' }}>
            {!isCollapsed && (
              <div
                onClick={() => setIsLaunchOpen(!isLaunchOpen)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 8px 6px',
                  cursor: 'pointer',
                  userSelect: 'none'
                }}
              >
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--text-3)'
                  }}
                >
                  Launchpad
                </span>
                <ChevronDown
                  size={14}
                  color="var(--text-3)"
                  style={{
                    transform: isLaunchOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                    transition: 'transform 0.15s ease'
                  }}
                />
              </div>
            )}

            {(isCollapsed || isLaunchOpen) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {launchItems.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      title={item.name}
                      onClick={() => {
                        onSelectTab(item.id);
                        if (!isDesktop) onClose();
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: isCollapsed ? 'center' : 'flex-start',
                        gap: '10px',
                        width: '100%',
                        height: '40px',
                        padding: isCollapsed ? '0' : '0 10px',
                        borderRadius: '10px',
                        border: 'none',
                        background: isActive ? 'var(--accent-soft)' : 'transparent',
                        color: isActive ? 'var(--accent)' : 'var(--text-2)',
                        fontSize: '14px',
                        fontWeight: 500,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'var(--font-sans)',
                        transition: 'background 0.15s ease, color 0.15s ease'
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'var(--surface-2)';
                          e.currentTarget.style.color = 'var(--text)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.color = 'var(--text-2)';
                        }
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', color: isActive ? 'var(--accent)' : 'currentColor' }}>
                        {item.icon}
                      </span>
                      {!isCollapsed && (
                        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.name}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Section: Tools (agent tools, shown only while FEATURES.agents is on) */}
          {toolsItems.length > 0 && (
          <div style={{ marginBottom: '8px' }}>
            {!isCollapsed && (
              <div
                onClick={() => setIsToolsOpen(!isToolsOpen)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 8px 6px',
                  cursor: 'pointer',
                  userSelect: 'none'
                }}
              >
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--text-3)'
                  }}
                >
                  Tools
                </span>
                <ChevronDown
                  size={14}
                  color="var(--text-3)"
                  style={{
                    transform: isToolsOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                    transition: 'transform 0.15s ease'
                  }}
                />
              </div>
            )}

            {(isCollapsed || isToolsOpen) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {toolsItems.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      title={item.name}
                      onClick={() => {
                        onSelectTab(item.id);
                        if (!isDesktop) onClose();
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: isCollapsed ? 'center' : 'flex-start',
                        gap: '10px',
                        width: '100%',
                        height: '40px',
                        padding: isCollapsed ? '0' : '0 10px',
                        borderRadius: '10px',
                        border: 'none',
                        background: isActive ? 'var(--accent-soft)' : 'transparent',
                        color: isActive ? 'var(--accent)' : 'var(--text-2)',
                        fontSize: '14px',
                        fontWeight: 500,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'var(--font-sans)',
                        transition: 'background 0.15s ease, color 0.15s ease'
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'var(--surface-2)';
                          e.currentTarget.style.color = 'var(--text)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.color = 'var(--text-2)';
                        }
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', color: isActive ? 'var(--accent)' : 'currentColor' }}>
                        {item.icon}
                      </span>
                      {!isCollapsed && (
                        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.name}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {/* Section 2: Resources */}
          <div style={{ marginBottom: '8px' }}>
            {!isCollapsed && (
              <div
                onClick={() => setIsDocsOpen(!isDocsOpen)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 8px 6px',
                  cursor: 'pointer',
                  userSelect: 'none'
                }}
              >
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--text-3)'
                  }}
                >
                  Resources
                </span>
                <ChevronDown
                  size={14}
                  color="var(--text-3)"
                  style={{
                    transform: isDocsOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                    transition: 'transform 0.15s ease'
                  }}
                />
              </div>
            )}

            {(isCollapsed || isDocsOpen) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {docsItems.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      title={item.name}
                      onClick={() => {
                        onSelectTab(item.id);
                        if (!isDesktop) onClose();
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: isCollapsed ? 'center' : 'flex-start',
                        gap: '10px',
                        width: '100%',
                        height: '40px',
                        padding: isCollapsed ? '0' : '0 10px',
                        borderRadius: '10px',
                        border: 'none',
                        background: isActive ? 'var(--accent-soft)' : 'transparent',
                        color: isActive ? 'var(--accent)' : 'var(--text-2)',
                        fontSize: '14px',
                        fontWeight: 500,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'var(--font-sans)',
                        transition: 'background 0.15s ease, color 0.15s ease'
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'var(--surface-2)';
                          e.currentTarget.style.color = 'var(--text)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.color = 'var(--text-2)';
                        }
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', color: isActive ? 'var(--accent)' : 'currentColor' }}>
                        {item.icon}
                      </span>
                      {!isCollapsed && (
                        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.name}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

        </div>

        {/* Bottom block: Divider, Admin Panel, Wallet pill */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {isAdmin && (
            <button
              onClick={() => {
                onSelectTab('admin');
                if (!isDesktop) onClose();
              }}
              title="Admin panel"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: isCollapsed ? 'center' : 'flex-start',
                gap: '10px',
                width: '100%',
                height: '40px',
                padding: isCollapsed ? '0' : '0 10px',
                borderRadius: '10px',
                border: 'none',
                background: activeTab === 'admin' ? 'var(--accent-soft)' : 'transparent',
                color: activeTab === 'admin' ? 'var(--accent)' : 'var(--text-2)',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
                transition: 'background 0.15s ease, color 0.15s ease'
              }}
              onMouseEnter={(e) => {
                if (activeTab !== 'admin') {
                  e.currentTarget.style.background = 'var(--surface-2)';
                  e.currentTarget.style.color = 'var(--text)';
                }
              }}
              onMouseLeave={(e) => {
                if (activeTab !== 'admin') {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--text-2)';
                }
              }}
            >
              <Shield size={18} strokeWidth={1.75} />
              {!isCollapsed && <span>Admin panel</span>}
            </button>
          )}

          {hasWallet ? (
            isCollapsed ? (
              <WalletMenu theme="dark" side="right" onSelect={selectFromMenu} onLogout={handleDisconnect} trigger={(toggle) => (
              <button
                onClick={toggle}
                title={`Wallet: ${activeAddress}`}
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '12px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto'
                }}
              >
                <Wallet size={16} />
              </button>
              )} />
            ) : (
              <WalletMenu theme="dark" side="up" onSelect={selectFromMenu} onLogout={handleDisconnect} trigger={(toggle, menuOpen) => (
              <div
                style={{
                  height: '40px',
                  padding: '0 8px 0 10px',
                  borderRadius: '12px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px'
                }}
              >
                <button
                  type="button"
                  onClick={toggle}
                  title="Account and wallet"
                  aria-expanded={menuOpen}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1, height: '100%', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  <div
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: 'var(--green)',
                      flexShrink: 0
                    }}
                  />
                  <span
                    className="mono"
                    style={{
                      fontSize: '13px',
                      color: 'var(--text)',
                      fontFamily: 'var(--font-mono)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      minWidth: 0
                    }}
                  >
                    {shortAddress(activeAddress)}
                  </span>
                  {hasAgentWallet && active === 'agent' && (
                    <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: '99px', padding: '1px 6px', flexShrink: 0 }}>Agent</span>
                  )}
                  <ChevronUp size={14} color="var(--text-3)" style={{ marginLeft: 'auto', transform: menuOpen ? 'none' : 'rotate(180deg)', transition: 'transform 0.15s ease' }} />
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <button
                    onClick={handleCopy}
                    title="Copy address"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-3)',
                      cursor: 'pointer',
                      padding: '4px',
                      borderRadius: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-3)'; }}
                  >
                    {copied ? <Check size={14} color="var(--green)" /> : <Copy size={14} />}
                  </button>
                  <button
                    onClick={handleDisconnect}
                    title="Disconnect wallet"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-3)',
                      cursor: 'pointer',
                      padding: '4px',
                      borderRadius: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--red)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-3)'; }}
                  >
                    <LogOut size={14} />
                  </button>
                </div>
              </div>
              )} />
            )
          ) : (
            <button
              onClick={() => {
                login();
                if (!isDesktop) onClose();
              }}
              title="Connect wallet"
              className="btn btn-primary"
              style={{
                width: '100%',
                height: '40px',
                borderRadius: '12px',
                fontSize: '14px',
                fontWeight: 600,
                padding: isCollapsed ? '0' : '0 16px'
              }}
            >
              <Wallet size={16} strokeWidth={1.75} />
              {!isCollapsed && <span>Connect wallet</span>}
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
