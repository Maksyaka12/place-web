import { useState } from 'react';
import {
  Compass,
  Gift,
  PlusCircle,
  LayoutDashboard,
  Wallet,
  ArrowLeftRight,
  BookOpen,
  MoreHorizontal,
  Puzzle,
  Bot,
  Shield,
  Palette,
  Rocket,
  Plus,
  UserRound,
  X,
  Coins,
  Boxes,
} from 'lucide-react';
import { useWallets } from '@privy-io/react-auth';
import { useAccount } from 'wagmi';
import { THEMES, getTheme, setTheme } from '../../../theme';
import { usePlaceWallets } from '../../../hooks/usePlaceWallets';
import { isPlaceAdmin } from '../../../place/moderation';
import { FEATURES } from '../../../config/features';


const NAV_TABS = [
  { id: 'explore', label: 'Explore', Icon: Compass },
  { id: 'launch', label: 'Launch', Icon: Rocket },
  { id: 'create', label: 'Create', Icon: PlusCircle },
  { id: 'rewards', label: 'Rewards', Icon: Gift }
];

// Pages without a tab of their own, opened from the More sheet.
const MORE_ITEMS = [
  { id: 'mine', label: 'My campaigns', Icon: LayoutDashboard },
  { id: 'staking', label: 'Staking', Icon: Coins },
  { id: 'projects', label: 'Projects', Icon: Boxes },
  { id: 'launch-new', label: 'Launch token', Icon: Plus },
  { id: 'launch-profile', label: 'Creator console', Icon: UserRound },
  { id: 'wallet', label: 'Wallet', Icon: Wallet },
  { id: 'buy', label: 'Swap', Icon: ArrowLeftRight },
  { id: 'docs', label: 'Docs', Icon: BookOpen },
  ...(FEATURES.agents ? [{ id: 'skill', label: 'Skill', Icon: Puzzle }] : [])
];

export function BaseAppBottomNav({ activeTab, onSelectTab }) {
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const currentTheme = getTheme();
  const { wallets } = useWallets();
  const { address: wagmiAddress } = useAccount();

  const { activeAddress: placeActiveAddress } = usePlaceWallets();
  const activeAddress = placeActiveAddress || wallets?.[0]?.address || wagmiAddress;
  const isAdmin = isPlaceAdmin(activeAddress);

  // Pages without their own tab open from More, so the marker rests there
  const tabIndex = NAV_TABS.findIndex((tab) => tab.id === activeTab);
  const currentIndex = isMoreOpen || tabIndex < 0 ? NAV_TABS.length : tabIndex;

  const handleTabClick = (tabId) => {
    onSelectTab(tabId);
    setIsMoreOpen(false);
  };

  return (
    <>
      {/* Bottom Tab Bar. Styles: components.css, Based glass version: based.css */}
      <nav className="base-app-bottom-nav">
        <div className="bnav-track">
          {/* Sliding marker on the current section, shown in Based */}
          <span className="bnav-glider" style={{ '--bnav-i': currentIndex }} aria-hidden="true" />

          {NAV_TABS.map(({ id, label, Icon }, index) => (
            id === 'create' ? (
              /* Create: the raised centre button in Dark */
              <button
                key={id}
                type="button"
                className="bnav-item bnav-item-hub"
                aria-current={currentIndex === index ? 'page' : undefined}
                onClick={() => handleTabClick(id)}
              >
                <div className="bnav-hub-icon">
                  <Icon size={24} strokeWidth={2} />
                </div>
                <span className="bnav-hub-label">{label}</span>
              </button>
            ) : (
              <button
                key={id}
                type="button"
                className={`bnav-item ${activeTab === id ? 'active' : ''}`.trim()}
                aria-current={currentIndex === index ? 'page' : undefined}
                onClick={() => handleTabClick(id)}
              >
                <Icon size={22} strokeWidth={1.75} />
                <span>{label}</span>
              </button>
            )
          ))}

          <button
            type="button"
            className={`bnav-item ${isMoreOpen ? 'active' : ''}`.trim()}
            aria-current={currentIndex === NAV_TABS.length ? 'page' : undefined}
            onClick={() => setIsMoreOpen(true)}
          >
            <MoreHorizontal size={22} strokeWidth={1.75} />
            <span>More</span>
          </button>
        </div>
      </nav>

      {/* "More" Bottom Sheet Modal */}
      {isMoreOpen && (
        <>
          <div
            onClick={() => setIsMoreOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.7)',
              zIndex: 100000
            }}
          />
          <div
            style={{
              position: 'fixed',
              bottom: 0,
              left: 0,
              right: 0,
              background: 'var(--surface)',
              borderTop: '1px solid var(--border)',
              borderTopLeftRadius: '20px',
              borderTopRightRadius: '20px',
              zIndex: 100001,
              padding: '20px 20px calc(24px + env(safe-area-inset-bottom, 0px))',
              boxSizing: 'border-box',
              maxHeight: '80vh',
              overflowY: 'auto'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)' }}>More options</span>
              <button
                onClick={() => setIsMoreOpen(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-3)',
                  cursor: 'pointer',
                  padding: '4px'
                }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {MORE_ITEMS.map(({ id, label, Icon }) => (
                <button key={id} type="button" className="pl-place-more-item" onClick={() => handleTabClick(id)}>
                  <Icon size={18} color="var(--accent)" />
                  <span>{label}</span>
                </button>
              ))}

              {/* Agent Zone: in the agent colour, like the header button */}
              {FEATURES.agents && (
              <button
                onClick={() => handleTabClick('agents')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 14px',
                  borderRadius: '12px',
                  background: 'var(--agent)',
                  border: '1px solid var(--agent)',
                  color: 'var(--on-agent)',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                <Bot size={18} />
                <span>Agent Zone</span>
              </button>
              )}

              {isAdmin && (
                <button
                  onClick={() => handleTabClick('admin')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '12px 14px',
                    borderRadius: '12px',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  <Shield size={18} color="var(--red)" />
                  <span>Admin panel</span>
                </button>
              )}

              {/* Theme picker (the header switcher is hidden while the bottom nav is shown) */}
              <div style={{ marginTop: '8px', paddingTop: '12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '14px', fontWeight: 500, color: 'var(--text)' }}>
                  <Palette size={18} color="var(--accent)" />
                  Theme
                </span>
                <div className="seg" role="radiogroup" aria-label="Theme">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={t.id === currentTheme}
                      aria-selected={t.id === currentTheme}
                      onClick={() => setTheme(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

            </div>
          </div>
        </>
      )}
    </>
  );
}
