import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BaseAppHeader } from './BaseAppHeader';
import { BaseAppSidebar } from './BaseAppSidebar';
import { BaseAppBottomNav } from './BaseAppBottomNav';
import WalletToggle from '../../../components/wallet/WalletToggle';
import DemoBanner from '../../../components/demo/DemoBanner';
import { TryDemoStrip } from '../../../components/demo/TryDemoButton';
import { PageHeader } from './ui';
import ExplorePage from '../pages/place/ExplorePage';
// The page stylesheets stay in the first bundle, in the order they always had, so lazy pages look exactly the same.
import '../../../components/wallet/WalletPages.css';
import '../../../components/agent/AgentsPage.css';
import '../../../components/agent/SkillPage.css';
import './BaseAppTheme.css';

// Pages other than Explore load on demand, so the first visit downloads less. Once the app has shown,
// they are fetched in the background, so moving between pages stays instant.
const PAGES = {
  CampaignPage: () => import('../pages/place/CampaignPage'),
  TokenPage: () => import('../pages/place/TokenPage'),
  RewardsPage: () => import('../pages/place/RewardsPage'),
  CreatePage: () => import('../pages/place/CreatePage'),
  MyCampaignsPage: () => import('../pages/place/MyCampaignsPage'),
  AdminPage: () => import('../pages/place/AdminPage'),
  SwapPanel: () => import('./SwapPanel'),
  WalletPage: () => import('../../../components/wallet/WalletPage'),
  AccountPage: () => import('../../../components/wallet/AccountPage'),
  AgentsPage: () => import('../../../components/agent/AgentsPage'),
  SettingsPage: () => import('../../../components/wallet/SettingsPage'),
  SkillPage: () => import('../../../components/agent/SkillPage'),
  LaunchDashboard: () => import('../../../launch/ui/LaunchDashboard'),
  LaunchForm: () => import('../../../launch/ui/LaunchForm'),
  LaunchTokenPage: () => import('../../../launch/ui/LaunchTokenPage'),
  CreatorConsole: () => import('../../../launch/ui/CreatorConsole'),
  StakingPage: () => import('../../../launch/ui/StakingPage'),
  ProjectsPage: () => import('../../../launch/ui/ProjectsPage'),
};
const CampaignPage = lazy(PAGES.CampaignPage);
const TokenPage = lazy(PAGES.TokenPage);
const RewardsPage = lazy(PAGES.RewardsPage);
const CreatePage = lazy(PAGES.CreatePage);
const MyCampaignsPage = lazy(PAGES.MyCampaignsPage);
const AdminPage = lazy(PAGES.AdminPage);
const SwapPanel = lazy(PAGES.SwapPanel);
const WalletPage = lazy(PAGES.WalletPage);
const AccountPage = lazy(PAGES.AccountPage);
const AgentsPage = lazy(PAGES.AgentsPage);
const SettingsPage = lazy(PAGES.SettingsPage);
const SkillPage = lazy(PAGES.SkillPage);
const LaunchDashboard = lazy(PAGES.LaunchDashboard);
const LaunchForm = lazy(PAGES.LaunchForm);
const LaunchTokenPage = lazy(PAGES.LaunchTokenPage);
const CreatorConsole = lazy(PAGES.CreatorConsole);
const StakingPage = lazy(PAGES.StakingPage);
const ProjectsPage = lazy(PAGES.ProjectsPage);

let pagesWarm = false;
function warmPages() {
  if (pagesWarm) return;
  pagesWarm = true;
  const run = () => Object.values(PAGES).forEach((load) => load().catch(() => {}));
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

class BaseAppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('BaseAppView Error:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="pl-place-crash">
          <h2>Something went wrong</h2>
          <p>{this.state.error?.message || 'The page failed to load.'}</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Which page a path opens. Pages without a nav item highlight the section they belong to (`nav`). */
export function tabFromPath(pathname) {
  const p = pathname.toLowerCase();
  if (p.startsWith('/launch/new')) return 'launch-new';
  if (p.startsWith('/launch/token/')) return 'launch-token';
  if (p.startsWith('/launch/profile')) return 'launch-profile';
  if (p.startsWith('/launch')) return 'launch';
  if (p.startsWith('/campaign/')) return 'campaign';
  if (p.startsWith('/token/')) return 'token';
  if (p.startsWith('/rewards')) return 'rewards';
  if (p.startsWith('/create')) return 'create';
  if (p.startsWith('/my')) return 'mine';
  if (p.startsWith('/admin')) return 'admin';
  if (p.startsWith('/swap')) return 'buy';
  if (p.startsWith('/staking')) return 'staking';
  if (p.startsWith('/projects')) return 'projects';
  for (const t of ['wallet', 'account', 'agents', 'settings', 'skill']) if (p.startsWith(`/${t}`)) return t;
  return 'explore';
}

const NAV_OF = { campaign: 'explore', token: 'explore', 'launch-token': 'launch' };

export const TAB_PATHS = {
  explore: '/',
  rewards: '/rewards',
  create: '/create',
  mine: '/my',
  admin: '/admin',
  buy: '/swap',
  wallet: '/wallet',
  account: '/account',
  agents: '/agents',
  settings: '/settings',
  skill: '/skill',
  docs: '/docs',
  staking: '/staking',
  projects: '/projects',
  launch: '/launch',
  'launch-new': '/launch/new',
  'launch-profile': '/launch/profile',
};

function Page({ width = 1040, children }) {
  return (
    <section style={{ padding: '24px 0 60px 0' }}>
      <div style={{ maxWidth: `${width}px`, margin: '0 auto', padding: '0 14px' }}>{children}</div>
    </section>
  );
}

export function BaseAppView() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => { warmPages(); }, []);

  // Mobile drawer state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Desktop viewport check (>= 1024px)
  const [isDesktop, setIsDesktop] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 1024 : false));

  // Desktop sidebar collapsed state with localStorage persistence
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('place_sidebar_collapsed') === 'true';
    } catch (e) {
      return false;
    }
  });

  useEffect(() => {
    const handleResize = () => {
      const desktop = window.innerWidth >= 1024;
      setIsDesktop(desktop);
      if (desktop) setIsMobileSidebarOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleSidebarCollapse = () => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('place_sidebar_collapsed', String(next));
      } catch (e) {}
      return next;
    });
  };

  const tab = tabFromPath(location.pathname);
  const activeTab = NAV_OF[tab] || tab;

  const handleSelectTab = (tabId) => {
    navigate(TAB_PATHS[tabId] || '/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Compute desktop margin-left based on sidebar state (248px expanded, 64px collapsed)
  const desktopMarginLeft = isDesktop ? (isSidebarCollapsed ? '64px' : '248px') : '0px';

  let content;
  if (tab === 'campaign') content = <Page><CampaignPage /></Page>;
  else if (tab === 'token') content = <Page><TokenPage /></Page>;
  else if (tab === 'rewards') content = <Page><RewardsPage /></Page>;
  else if (tab === 'create') content = <Page width={760}><CreatePage /></Page>;
  else if (tab === 'mine') content = <Page><MyCampaignsPage /></Page>;
  else if (tab === 'admin') content = <Page><AdminPage /></Page>;
  else if (tab === 'staking') content = <Page><StakingPage /></Page>;
  else if (tab === 'projects') content = <Page width={1200}><ProjectsPage /></Page>;
  else if (tab === 'launch') content = <Page width={1200}><LaunchDashboard /></Page>;
  else if (tab === 'launch-new') content = <Page width={1120}><LaunchForm /></Page>;
  else if (tab === 'launch-token') content = <Page width={1200}><LaunchTokenPage /></Page>;
  else if (tab === 'launch-profile') content = <Page width={1120}><CreatorConsole /></Page>;
  else if (tab === 'buy') {
    content = (
      <Page width={480}>
        <PageHeader title="Swap" description="Instant exchange on Base via optimal liquidity routing" />
        <WalletToggle theme="dark" size="md" label="Swap with" />
        <SwapPanel />
      </Page>
    );
  } else if (tab === 'wallet') {
    content = (
      <Page width={560}>
        <PageHeader title="Wallet" description="Balances, deposits and transfers for your Place wallets" />
        <WalletPage theme="dark" onSwap={() => handleSelectTab('buy')} />
      </Page>
    );
  } else if (tab === 'agents') content = <Page><AgentsPage theme="dark" /></Page>;
  else if (tab === 'skill') content = <Page><SkillPage theme="dark" onOpenAgents={() => handleSelectTab('agents')} /></Page>;
  else if (tab === 'settings') {
    content = (
      <Page width={640}>
        <PageHeader title="Settings" description="What your agent can do with the agent wallet and its daily limits" />
        <SettingsPage theme="dark" onOpenAgents={() => handleSelectTab('agents')} />
      </Page>
    );
  } else if (tab === 'account') content = <Page width={560}><AccountPage theme="dark" onOpenWallet={() => handleSelectTab('wallet')} /></Page>;
  else content = <Page><ExplorePage /></Page>;

  return (
    <BaseAppErrorBoundary>
      <div className="base-app-shell" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '100vw', margin: 0, padding: 0 }}>
        <BaseAppSidebar
          isDesktop={isDesktop}
          isCollapsed={isDesktop && isSidebarCollapsed}
          onToggleCollapse={isDesktop ? toggleSidebarCollapse : undefined}
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
          isOpen={isDesktop || isMobileSidebarOpen}
          onClose={() => setIsMobileSidebarOpen(false)}
        />

        <div
          className="base-app-main-content-wrap"
          style={{
            marginLeft: desktopMarginLeft,
            transition: 'margin-left 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            width: isDesktop ? `calc(100% - ${desktopMarginLeft})` : '100%',
            maxWidth: '100%',
            boxSizing: 'border-box'
          }}
        >
          {/* Phones: the Try demo strip (desktop has the button in the header). While the demo is on: its banner. */}
          {!isDesktop && <TryDemoStrip />}
          <DemoBanner />

          <BaseAppHeader isDesktop={isDesktop} onOpenSidebar={() => setIsMobileSidebarOpen(true)} onSelectTab={handleSelectTab} />

          <main key={location.pathname} style={{ flex: 1, paddingBottom: isDesktop ? '40px' : '90px' }}>
            <Suspense fallback={null}>{content}</Suspense>
          </main>

          {!isDesktop && <BaseAppBottomNav activeTab={activeTab} onSelectTab={handleSelectTab} />}
        </div>
      </div>
    </BaseAppErrorBoundary>
  );
}
