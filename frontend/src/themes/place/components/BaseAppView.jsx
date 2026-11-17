import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BaseAppTopNav } from './BaseAppTopNav';
import WalletToggle from '../../../components/wallet/WalletToggle';
import { FEATURES } from '../../../config/features';
import { PageHeader } from './ui';
import LaunchDashboard from '../../../launch/ui/LaunchDashboard';
import { LiveTicker } from '../../../launch/ui/LiveTicker.jsx';
// The page stylesheets stay in the first bundle, in the order they always had, so lazy pages look exactly the same.
import '../../../components/wallet/WalletPages.css';
import '../../../components/agent/AgentsPage.css';
import '../../../components/agent/SkillPage.css';
import './BaseAppTheme.css';

// Pages other than the dashboard load on demand, so the first visit downloads less. Once the app has shown,
// they are fetched in the background, so moving between pages stays instant.
const PAGES = {
  HubPage: () => import('../../../launch/ui/HubPage'),
  HubCreatePage: () => import('../../../launch/ui/HubCreatePage'),
  LaunchNftPage: () => import('../../../launch/ui/LaunchNftPage'),
  CampaignPage: () => import('../pages/place/CampaignPage'),
  TokenPage: () => import('../pages/place/TokenPage'),
  RewardsPage: () => import('../pages/place/RewardsPage'),
  MyCampaignsPage: () => import('../pages/place/MyCampaignsPage'),
  AdminPage: () => import('../pages/place/AdminPage'),
  SwapPanel: () => import('./SwapPanel'),
  WalletPage: () => import('../../../components/wallet/WalletPage'),
  AccountPage: () => import('../../../components/wallet/AccountPage'),
  LaunchForm: () => import('../../../launch/ui/LaunchForm'),
  LaunchTokenPage: () => import('../../../launch/ui/LaunchTokenPage'),
  CreatorConsole: () => import('../../../launch/ui/CreatorConsole'),
  StakingPage: () => import('../../../launch/ui/StakingPage'),
  ProjectsPage: () => import('../../../launch/ui/ProjectsPage'),
  StocksPage: () => import('../../../launch/ui/StocksPage'),
  ...(FEATURES.agents
    ? {
        AgentsPage: () => import('../../../components/agent/AgentsPage'),
        SettingsPage: () => import('../../../components/wallet/SettingsPage'),
        SkillPage: () => import('../../../components/agent/SkillPage'),
      }
    : {}),
};
const RewardsHub = lazy(PAGES.HubPage);
const HubCreatePage = lazy(PAGES.HubCreatePage);
const LaunchNftPage = lazy(PAGES.LaunchNftPage);
const CampaignPage = lazy(PAGES.CampaignPage);
const TokenPage = lazy(PAGES.TokenPage);
const RewardsPage = lazy(PAGES.RewardsPage);
const MyCampaignsPage = lazy(PAGES.MyCampaignsPage);
const AdminPage = lazy(PAGES.AdminPage);
const SwapPanel = lazy(PAGES.SwapPanel);
const WalletPage = lazy(PAGES.WalletPage);
const AccountPage = lazy(PAGES.AccountPage);
const AgentsPage = lazy(() => import('../../../components/agent/AgentsPage'));
const SettingsPage = lazy(() => import('../../../components/wallet/SettingsPage'));
const SkillPage = lazy(() => import('../../../components/agent/SkillPage'));
const LaunchForm = lazy(PAGES.LaunchForm);
const LaunchTokenPage = lazy(PAGES.LaunchTokenPage);
const CreatorConsole = lazy(PAGES.CreatorConsole);
const StakingPage = lazy(PAGES.StakingPage);
const ProjectsPage = lazy(PAGES.ProjectsPage);
const StocksPage = lazy(PAGES.StocksPage);

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

// Agent pages (Agent Zone, agent settings, skill) exist only while FEATURES.agents is on.
const AGENT_TABS = ['agents', 'settings', 'skill'];

/** Which page a path opens. */
export function tabFromPath(pathname) {
  const p = pathname.toLowerCase();
  if (p === '/' || p === '') return 'dashboard';
  if (p.startsWith('/stocks')) return 'stocks';
  if (p.startsWith('/launch/new')) return 'launch-new';
  if (p.startsWith('/launch/nft')) return 'launch-nft';
  if (p.startsWith('/launch/token/')) return 'launch-token';
  if (p.startsWith('/profile')) return 'profile';
  if (p.startsWith('/hub')) return 'hub';
  if (p.startsWith('/campaign/')) return 'campaign';
  if (p.startsWith('/token/')) return 'token';
  if (p.startsWith('/rewards')) return 'rewards';
  if (p.startsWith('/create')) return 'create';
  if (p.startsWith('/my')) return 'mine';
  if (p.startsWith('/admin')) return 'admin';
  if (p.startsWith('/swap')) return 'buy';
  if (p.startsWith('/staking')) return 'staking';
  if (p.startsWith('/projects')) return 'projects';
  for (const t of ['wallet', 'account', ...(FEATURES.agents ? AGENT_TABS : [])]) if (p.startsWith(`/${t}`)) return t;
  return 'dashboard';
}

/** The top-bar section a page belongs to. The Rewards hub groups the campaign, staking and claim pages. */
const HUB_TABS = ['hub', 'campaign', 'token', 'rewards', 'create', 'mine', 'staking', 'projects', 'launch-nft'];
export function sectionOf(tab) {
  if (tab === 'dashboard' || tab === 'launch-token' || tab === 'launch-new') return 'dashboard';
  if (tab === 'stocks') return 'stocks';
  if (tab === 'profile') return 'profile';
  if (HUB_TABS.includes(tab)) return 'hub';
  return null;
}

const HUB_LINKS = [
  { tab: 'hub', label: 'All rewards', to: '/hub' },
  { tab: 'rewards', label: 'My rewards', to: '/rewards' },
  { tab: 'create', label: 'Create', to: '/create' },
  { tab: 'mine', label: 'My campaigns', to: '/my' },
  { tab: 'projects', label: 'Projects', to: '/projects' },
];

/** The Rewards hub's own section row, above each hub page (the type tabs of All rewards hold Staking). */
function HubTabs({ tab }) {
  const active = tab === 'campaign' || tab === 'token' || tab === 'staking' ? 'hub' : tab;
  return (
    <nav className="seg soft pl-hub-tabs" aria-label="Rewards hub">
      {HUB_LINKS.map((l) => (
        <Link key={l.to} to={l.to} aria-current={active === l.tab ? 'page' : undefined} aria-selected={active === l.tab}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

/** Width of the widest pages: dashboards, the token page, the launch form and the profile. */
const WIDE = 1536;

function Page({ width = 1040, children }) {
  return (
    <section style={{ padding: '24px 0 60px 0' }}>
      <div style={{ maxWidth: `${width}px`, margin: '0 auto', padding: '0 16px' }}>{children}</div>
    </section>
  );
}

function HubPage({ tab, width = WIDE, children }) {
  return (
    <Page width={width}>
      <HubTabs tab={tab} />
      {children}
    </Page>
  );
}

export function BaseAppView() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => { warmPages(); }, []);

  const [isDesktop, setIsDesktop] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 1024 : false));
  useEffect(() => {
    const handleResize = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const tab = tabFromPath(location.pathname);
  const go = (path) => {
    navigate(path);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  let content;
  if (tab === 'dashboard') content = <Page width={WIDE}><LaunchDashboard /></Page>;
  else if (tab === 'stocks') content = <Page width={WIDE}><StocksPage /></Page>;
  else if (tab === 'launch-new') content = <Page width={WIDE}><LaunchForm /></Page>;
  else if (tab === 'launch-token') content = <Page width={WIDE}><LaunchTokenPage /></Page>;
  else if (tab === 'profile') content = <Page width={WIDE}><CreatorConsole /></Page>;
  else if (tab === 'hub') content = <HubPage tab={tab}><RewardsHub /></HubPage>;
  else if (tab === 'campaign') content = <HubPage tab={tab}><CampaignPage /></HubPage>;
  else if (tab === 'token') content = <HubPage tab={tab}><TokenPage /></HubPage>;
  else if (tab === 'rewards') content = <HubPage tab={tab}><RewardsPage /></HubPage>;
  else if (tab === 'create') content = <HubPage tab={tab}><HubCreatePage /></HubPage>;
  else if (tab === 'launch-nft') content = <Page width={WIDE}><LaunchNftPage /></Page>;
  else if (tab === 'mine') content = <HubPage tab={tab}><MyCampaignsPage /></HubPage>;
  else if (tab === 'staking') content = <HubPage tab={tab}><StakingPage /></HubPage>;
  else if (tab === 'projects') content = <HubPage tab={tab}><ProjectsPage /></HubPage>;
  else if (tab === 'admin') content = <Page><AdminPage /></Page>;
  else if (tab === 'buy') {
    content = (
      <Page width={480}>
        <PageHeader title="Swap" description="Instant exchange on Base via optimal liquidity routing" />
        {FEATURES.agents && <WalletToggle theme="dark" size="md" label="Swap with" />}
        <SwapPanel />
      </Page>
    );
  } else if (tab === 'wallet') {
    content = (
      <Page width={560}>
        <PageHeader title="Wallet" description={FEATURES.agents ? 'Balances, deposits and transfers for your Place wallets' : 'Balances, deposits and transfers for your wallet'} />
        <WalletPage theme="dark" onSwap={() => go('/swap')} />
      </Page>
    );
  } else if (tab === 'agents') content = <Page><AgentsPage theme="dark" /></Page>;
  else if (tab === 'skill') content = <Page><SkillPage theme="dark" onOpenAgents={() => go('/agents')} /></Page>;
  else if (tab === 'settings') {
    content = (
      <Page width={640}>
        <PageHeader title="Settings" description="What your agent can do with the agent wallet and its daily limits" />
        <SettingsPage theme="dark" onOpenAgents={() => go('/agents')} />
      </Page>
    );
  } else if (tab === 'account') content = <Page width={560}><AccountPage theme="dark" onOpenWallet={() => go('/wallet')} /></Page>;

  return (
    <BaseAppErrorBoundary>
      <div className="base-app-shell pl-shell">
        <BaseAppTopNav activeSection={sectionOf(tab)} isDesktop={isDesktop} />
        <LiveTicker />
        <main key={location.pathname} className="pl-shell-main">
          <Suspense fallback={null}>{content}</Suspense>
        </main>
      </div>
    </BaseAppErrorBoundary>
  );
}
