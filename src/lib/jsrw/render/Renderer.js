import { JsrwRendererSession } from '../integration/JsrwRendererSession.js';

export class Renderer extends JsrwRendererSession {}

export function createRenderer(options = {}) {
  return new Renderer(options);
}

export default Renderer;
