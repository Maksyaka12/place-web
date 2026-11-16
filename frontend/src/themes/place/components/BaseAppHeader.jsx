import { Menu, Wallet } from 'lucide-react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useAccount } from 'wagmi';
import { PLACE_CHAIN } from '../../../place/chain';
import { shortAddress } from '../../../place/format';
import { ThemeSwitcher } from './ThemeSwitcher';
import WalletToggle from '../../../components/wallet/WalletToggle';
import AgentsButton from '../../../components/agent/AgentsButton';
import { usePlaceWallets } from '../../../hooks/usePlaceWallets';
import TryDemoButton from '../../../components/demo/TryDemoButton';

export function BaseAppHeader({ onOpenSidebar, onSelectTab, isDesktop = false }) {
  const { login, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { address: wagmiAddress, isConnected: isWagmiConnected } = useAccount();

  const { activeAddress: placeActiveAddress, isDemo } = usePlaceWallets();
  const activeAddress = placeActiveAddress || wallets?.[0]?.address || wagmiAddress;
  // the read-only demo shows the demo address, as for a connected wallet
  const hasWallet = (authenticated && !!activeAddress) || (isWagmiConnected && !!wagmiAddress) || (isDemo && !!activeAddress);

  return (
    <header
      className="base-app-header"
      style={{
        height: '64px',
        background: 'var(--bg-bar)',
        borderBottom: '1px solid var(--border)',
        // desktop: three columns, so Try demo sits in the middle of the header whatever the sides hold
        ...(isDesktop
          ? { display: 'grid', gridTemplateColumns: '1fr auto 1fr', columnGap: '16px' }
          : { display: 'flex', justifyContent: 'space-between' }),
        alignItems: 'center',
        padding: isDesktop ? '0 24px' : '0 8px',
        position: 'sticky',
        top: 0,
        zIndex: 50,
        color: 'var(--text)',
        fontFamily: 'var(--font-sans)',
        boxSizing: 'border-box'
      }}
    >
      {/* Left side: Mobile hamburger menu & logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: isDesktop ? '10px' : '4px', flexShrink: 0 }}>
        {!isDesktop && (
          <button
            onClick={onOpenSidebar}
            aria-label="Open menu"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-2)',
              cursor: 'pointer',
              padding: isDesktop ? '6px' : '4px',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Menu size={20} strokeWidth={1.75} />
          </button>
        )}

        {!isDesktop && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', userSelect: 'none' }}>
            <img
              src="/logo.svg"
              alt="Place"
              style={{
                width: '24px',
                height: '24px',
                borderRadius: '6px',
                objectFit: 'cover',
                border: '1px solid var(--border)'
              }}
            />
          </div>
        )}
      </div>

      {/* Desktop: Try demo in the middle, always there (also with a wallet connected) */}
      {isDesktop && (
        <div className="pl-demo-try-slot">
          <TryDemoButton isDesktop />
        </div>
      )}

      {/* Right side: two pills or Connect Wallet */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', justifySelf: 'end', gap: isDesktop ? '8px' : '4px', minWidth: 0 }}>
        <AgentsButton theme="dark" />
        {hasWallet && !isDemo && <WalletToggle theme="dark" size="sm" />}
        {isDesktop && <ThemeSwitcher />}
        {hasWallet ? (
          <button
            type="button"
            className="pl-pill pl-place-address-pill"
            title={activeAddress}
            onClick={() => onSelectTab?.('wallet')}
          >
            <span className="pl-place-chain-dot" aria-hidden="true" />
            <span className="mono">{shortAddress(activeAddress)}</span>
            {isDesktop && <span className="pl-place-chain-name">{PLACE_CHAIN.name}</span>}
          </button>
        ) : (
          <button
            onClick={login}
            className="btn btn-primary"
            style={{
              height: '36px',
              padding: '0 16px',
              borderRadius: '999px',
              fontSize: '14px'
            }}
          >
            <Wallet size={16} strokeWidth={1.75} />
            <span>Connect wallet</span>
          </button>
        )}
      </div>
    </header>
  );
}
