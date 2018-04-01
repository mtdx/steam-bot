#!/usr/bin/env node

import { Transform } from 'stream';

class Prepender extends Transform {
  _transform(chunk: Buffer, encoding, done) {
    const date = (new Date()).toISOString();

    chunk
      .toString()
      .split('\n')
      .filter(line => !!line)
      .forEach(line => {
        let prefix = date;

        try {
          const parsed = JSON.parse(line);

          if (parsed.time) {
            prefix = parsed.time;
          }
        } catch (e) {
          // nothing
        } finally {
          this.push(prefix + ' ' + line + '\r\n');
        }
      });

    done();
  }
}

const xform = new Prepender();

process.stdin
  .pipe(xform)
  .pipe(process.stdout);
