import { useCallback, useEffect, useState } from 'react';
import { usePrivy, useSigners } from '@privy-io/react-auth';
import { Bot, ShieldCheck, ShieldOff, RefreshCw } from 'lucide-react';
import { isWalletRejection } from '../../config/walletTx';
import { CopyButton } from './WalletPage';

// "Agent access" on the Account page: lets our server sign for the user's agent wallet (Privy signer, the user
// approves once, revocable) and issues the agent key the user hands to their AI agent.

const AGENT_SIGNER_ID = import.meta.env.VITE_PRIVY_SIGNER_ID || '';

export default function AgentAccessCard({ agentAddress }) {
  const { getAccessToken } = usePrivy();
  const { addSigners, removeSigners } = useSigners();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newKey, setNewKey] = useState('');

  const api = useCallback(async (method) => {
    const token = await getAccessToken();
    const res = await fetch('/api/agent/token', { method, headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }, [getAccessToken]);

  const load = useCallback(async () => {
    try {
      setState(await api('GET'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [api]);

  useEffect(() => {
    if (agentAddress) load();
  }, [agentAddress, load]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(isWalletRejection(e) ? 'Cancelled' : (e.message || 'Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  const enable = () => run(async () => {
    if (!AGENT_SIGNER_ID) throw new Error('Agent access is not set up on this site yet');
    if (!state?.signer) await addSigners({ address: agentAddress, signers: [{ signerId: AGENT_SIGNER_ID }] });
    const { token } = await api('POST');
    setNewKey(token);
    await load();
  });

  const rotate = () => run(async () => {
    const { token } = await api('POST');
    setNewKey(token);
    await load();
  });

  const disable = () => run(async () => {
    await api('DELETE');
    if (state?.signer) await removeSigners({ address: agentAddress });
    setNewKey('');
    await load();
  });

  if (!agentAddress) return null;
  const enabled = Boolean(state?.signer && state?.hasKey);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="pw-card">
      <div className="pw-card-head">
        <div className="pw-card-title">Agent access</div>
        {state && (
          <span className={`pw-badge ${enabled ? '' : 'off'}`}>{enabled ? 'Enabled' : 'Off'}</span>
        )}
      </div>
      <p className="pw-hint">
        Let your AI agent use the agent wallet on its own: swap and send funds,
        with no signatures. Transfers to your main wallet are unlimited, to other addresses they are capped per day.
        Your main wallet is never touched.
      </p>

      {newKey && (
        <div className="pw-key">
          <div className="pw-section-label">Your agent key: copy it now, it is shown only once</div>
          <div className="pw-address-box">
            <span className="pw-mono">{newKey}</span>
            <CopyButton value={newKey} />
          </div>
          <p className="pw-hint">
            Give it to your agent with the API: <span className="pw-mono">{origin}/api/agent</span>. The agent sends
            {' '}<span className="pw-mono">Authorization: Bearer &lt;key&gt;</span> to <span className="pw-mono">POST /api/agent/act</span>.
          </p>
        </div>
      )}

      {state && !enabled && (
        <button type="button" className="pw-btn pw-btn-primary pw-btn-full" onClick={enable} disabled={busy}>
          <Bot size={16} /> {busy ? 'Confirming…' : state.signer ? 'Create agent key' : 'Enable agent'}
        </button>
      )}
      {enabled && (
        <>
          <div className="pw-muted">
            <ShieldCheck size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Key created {new Date(state.keyCreatedAt).toLocaleString()}
          </div>
          <div className="pw-actions pw-actions-2">
            <button type="button" className="pw-btn" onClick={rotate} disabled={busy}>
              <RefreshCw size={15} /> New key
            </button>
            <button type="button" className="pw-btn pw-btn-danger" onClick={disable} disabled={busy}>
              <ShieldOff size={15} /> Disable agent
            </button>
          </div>
        </>
      )}
      {!state && !error && <div className="pw-muted">Checking…</div>}
      {error && <div className="pw-notice err">{error}</div>}
    </div>
  );
}
