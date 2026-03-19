import { JsrwRendererSession } from './JsrwRendererSession.js';

export function createJsrwRenderer(options = {}) {
  return new JsrwRendererSession(options);
}

export default createJsrwRenderer;
