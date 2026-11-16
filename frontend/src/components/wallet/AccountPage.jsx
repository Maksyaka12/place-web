import { usePrivy, useExportWallet } from '@privy-io/react-auth';
import { Bot, Wallet as WalletIcon, KeyRound, ArrowRight } from 'lucide-react';
import { usePlaceWallets } from '../../hooks/usePlaceWallets';
import { CopyButton, shortAddr } from './WalletPage';
import AgentAccessCard from './AgentAccessCard';
import './WalletPages.css';

// Account settings shared by both themes: the account's two wallets. Login is wallet-only:
// the connected wallet is the main one, the Privy embedded wallet created at login is the agent wallet.

export default function AccountPage({ theme = 'dark', onOpenWallet }) {
  const { user } = usePrivy();
  const { exportWallet } = useExportWallet();
  const { mainAddress, agentAddress, hasAgentWallet, active, isDemo } = usePlaceWallets();

  // the read-only demo never shows or exports the visitor's own account
  if (isDemo) {
    return <div className={`pw pw-${theme}`}><div className="pw-card pw-empty">Account settings are not part of the read-only demo.</div></div>;
  }

  if (!user || !mainAddress) {
    return <div className={`pw pw-${theme}`}><div className="pw-card pw-empty">Log in to manage your account.</div></div>;
  }

    const handle = shortAddr(mainAddress);
  const avatar = '/logo.png';

  const wallets = hasAgentWallet
    ? [
        { key: 'agent', name: 'Agent wallet', address: agentAddress, icon: <Bot size={18} />, embedded: true },
        { key: 'main', name: 'Main wallet', address: mainAddress, icon: <WalletIcon size={18} />, embedded: false },
      ]
    : [{ key: 'main', name: 'Place wallet', address: mainAddress, icon: <Bot size={18} />, embedded: agentAddress?.toLowerCase() === mainAddress.toLowerCase() }];

  return (
    <div className={`pw pw-${theme}`}>
      <div className="pw-identity">
        <img src={avatar} alt="" className="pw-avatar" />
        <div className="pw-handle">{handle}</div>
      </div>

      <div className="pw-card">
        <div className="pw-card-title">Wallets</div>
        <div className="pw-muted pw-sub">
          {hasAgentWallet
            ? 'Your account has two wallets: the one you connected and the agent wallet created for you at login.'
            : 'The wallet created for you at login. You and your agent both use it.'}
        </div>
        <div className="pw-wallets">
          {wallets.map((w) => (
            <div key={w.key} className="pw-wallet-row static">
              <span className="pw-wallet-icon">{w.icon}</span>
              <span className="pw-wallet-text">
                <span className="pw-wallet-name">
                  {w.name}
                  {hasAgentWallet && w.key === active && <span className="pw-badge">Active</span>}
                </span>
                <span className="pw-address-line">
                  <a className="pw-mono pw-muted" href={`https://basescan.org/address/${w.address}`} target="_blank" rel="noopener noreferrer">{shortAddr(w.address)}</a>
                  <CopyButton value={w.address} size={12} />
                </span>
              </span>
              {w.embedded && (
                <button type="button" className="pw-btn pw-btn-sm" onClick={() => exportWallet({ address: w.address }).catch(() => {})} title="Show the private key of this wallet">
                  <KeyRound size={14} /> Export key
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="pw-btn pw-btn-full" onClick={onOpenWallet}>
          Open wallet <ArrowRight size={14} />
        </button>
      </div>

      <AgentAccessCard agentAddress={hasAgentWallet ? agentAddress : null} />
    </div>
  );
}
