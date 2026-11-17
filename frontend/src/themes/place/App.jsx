import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { PrivyProvider, dataSuffix } from '@privy-io/react-auth';
import { WagmiProvider as PrivyWagmiProvider } from '@privy-io/wagmi';
import { privyWagmiConfig } from '../../config/privyWagmi';
import { DATA_SUFFIX } from '../../config/builderCode';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { base, baseSepolia } from 'viem/chains';
import { BaseAppView } from './components/BaseAppView';
import { FEATURES } from '../../config/features';
import { PLACE_CHAIN } from '../../place/chain';
import './index.css';

const DocsPage = lazy(() => import('./pages/docs/DocsPage'));
const docs = <Suspense fallback={null}><DocsPage /></Suspense>;

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// Every app page renders inside the same shell; BaseAppView picks the page from the path.
const shell = <BaseAppView />;
const SHELL_PATHS = [
  '/',
  '/stocks',
  '/profile',
  '/profile/:section',
  '/hub',
  '/campaign/:hub/:id',
  '/token/:address',
  '/create',
  '/admin',
  '/swap',
  '/wallet',
  '/account',
  ...(FEATURES.agents ? ['/agents', '/settings', '/skill'] : []),
  '/staking',
  '/projects',
  '/projects/register',
  '/launch/new',
  '/launch/nft',
  '/launch/token/:address',
];

// Old launchpad links keep working: /launch/profile/fees opens /profile/fees.
function LegacyProfileRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={`${pathname.replace(/^\/launch\/profile/, '/profile')}${search}`} replace />;
}

// Former Rewards hub tabs: My rewards and My campaigns now live in the profile.
function MovedTo({ to }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

function DomainRouter() {
  useEffect(() => {
    document.title = 'Place';
  }, []);

  return (
    <Routes>
      {SHELL_PATHS.map((path) => (
        <Route key={path} path={path} element={shell} />
      ))}
      <Route path="/launch" element={<Navigate to="/" replace />} />
      <Route path="/create/collection" element={<Navigate to="/launch/nft" replace />} />
      <Route path="/create/:kind" element={<Navigate to="/create" replace />} />
      <Route path="/launch/profile/*" element={<LegacyProfileRedirect />} />
      <Route path="/rewards" element={<MovedTo to="/profile/rewards" />} />
      <Route path="/my" element={<MovedTo to="/profile/campaigns" />} />
      <Route path="/docs" element={docs} />
      <Route path="/docs/:slug" element={docs} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
});

export default function App() {
  return (
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID || 'cmwdlylbc015d0hjq5a5ybnlv'}
      config={{
        plugins: DATA_SUFFIX ? [dataSuffix(DATA_SUFFIX)] : [],
        loginMethods: ['wallet'],
        defaultChain: PLACE_CHAIN,
        supportedChains: [base, baseSepolia],
        appearance: {
          theme: 'dark',
          accentColor: '#66BEFF',
          logo: `${window.location.origin}/logo.png`, // absolute: wallet popups resolve it on their own domain
          showWalletLoginFirst: true,
        },
        embeddedWallets: {
          ethereum: { createOnLogin: 'all-users' }
        }
      }}
    >
      <QueryClientProvider client={queryClient}>
        <PrivyWagmiProvider config={privyWagmiConfig}>
          <BrowserRouter>
            <ScrollToTop />
            <DomainRouter />
          </BrowserRouter>
        </PrivyWagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
