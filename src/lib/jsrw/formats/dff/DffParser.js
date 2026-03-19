import DFFReader from '../../Reader.js';

export class DffParser {
  parse(input) {
    const reader = new DFFReader();
    return reader.parse(input);
  }
}

export default DffParser;
