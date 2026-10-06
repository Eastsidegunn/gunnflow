/* @refresh reload */
import { render } from 'solid-js/web';
import { App } from './App.jsx';
import { applyChrome } from './theme/defaultTheme.js';
import './styles.css';

applyChrome(); // the chrome palette is theme data, injected before first render
render(() => <App />, document.getElementById('root')!);
