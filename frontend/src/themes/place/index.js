// App is imported before the global stylesheets on purpose: it keeps the same CSS
// order as the original entry (component CSS first, then index.css and the page styles).
import App from './App.jsx';
import './index.css';
import './styles/tokens.css';
import './styles/components.css';
import './styles/hub.css';
import './styles/claim.css';
import './styles/swap.css';
import './styles/docs.css';
import './styles/place.css';
import './styles/launch.css';
import './styles/rewards.css';
import './styles/collections.css';
import './styles/based.css';

export default App;
