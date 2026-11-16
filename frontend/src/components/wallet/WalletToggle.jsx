import { Bot, Wallet } from 'lucide-react';
import { usePlaceWallets } from '../../hooks/usePlaceWallets';
import './WalletPages.css';

// Quick Main / Agent switch. size "sm" sits in the header, "md" above the swap (with a label and the address).
// Hidden for accounts that have only one wallet.

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export default function WalletToggle({ theme = 'dark', size = 'sm', label }) {
  const { hasAgentWallet, active, activeAddress, setActive } = usePlaceWallets();
  if (!hasAgentWallet) return null;

  const options = [
    { key: 'main', text: 'Main', icon: Wallet },
    { key: 'agent', text: 'Agent', icon: Bot },
  ];

  const toggle = (
    <div className={`pwt-switch ${active === 'agent' ? 'is-agent' : ''}`} role="radiogroup" aria-label="Active wallet">
      <span className="pwt-thumb" aria-hidden="true" />
      {options.map(({ key, text, icon: Icon }) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={active === key}
          className={active === key ? 'on' : ''}
          onClick={() => setActive(key)}
          title={key === 'main' ? 'Use your main wallet' : 'Use your agent wallet'}
        >
          <Icon size={size === 'sm' ? 13 : 14} />
          <span className="pwt-text">{text}</span>
        </button>
      ))}
    </div>
  );

  if (size === 'sm') return <div className={`pw-${theme} pwt pwt-sm`}>{toggle}</div>;

  return (
    <div className={`pw-${theme} pwt pwt-md`}>
      <div className="pwt-info">
        <span className="pwt-label">{label || 'Wallet'}</span>
        <span className="pwt-address">{active === 'agent' ? 'Agent wallet' : 'Main wallet'} · {short(activeAddress)}</span>
      </div>
      {toggle}
    </div>
  );
}
