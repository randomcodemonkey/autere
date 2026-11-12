/** HTML error pages from providers must reach the chat as one readable line. */
import assert from 'node:assert';
import { cleanProviderError } from './error-text.js';

const unicorn = `github-copilot API error (503): 503 <!DOCTYPE html>
<!--
Hello future GitHubber! I bet you're here to remove those nasty inline styles,
DRY up these templates and make 'em nice and re-usable, right?
-->
<html>
  <head>
    <title>Unicorn! &middot; GitHub</title>
    <style>body { margin: 0; font-family: sans-serif; }</style>
  </head>
  <body>
    <h1>Unicorn!</h1>
    <p>This page is taking too long to load. &amp; it may be gone for good.</p>
    <script>window.dropped = 'never shown';</script>
  </body>
</html>`;

const cleaned = cleanProviderError(unicorn);
assert.ok(!cleaned.includes('<'), `markup leaked: ${cleaned}`);
assert.ok(!cleaned.includes('window.dropped'), 'script body leaked');
assert.ok(!cleaned.includes('font-family'), 'style body leaked');
assert.ok(!cleaned.includes('<!--'), 'comment leaked');
assert.ok(cleaned.startsWith('github-copilot API error (503):'), `prefix lost: ${cleaned}`);
assert.ok(!cleaned.includes('503 503'), 'doubled status');
assert.ok(cleaned.includes('HTML error page ("Unicorn! GitHub")'), `title lost: ${cleaned}`);
assert.ok(cleaned.includes('This page is taking too long to load. & it may be gone for good.'), `visible text lost: ${cleaned}`);
assert.ok(/\bKB of HTML omitted\]$/.test(cleaned), `size note lost: ${cleaned}`);
assert.ok(cleaned.length < 600, `still huge (${cleaned.length} chars)`);

// JSON / plain provider errors are untouched
const json = '503: {"message":"[opencode-go/glm-5.3-flash] [502]: fetch connect timeout"}';
assert.strictEqual(cleanProviderError(json), json);
// ... and so is any text that merely mentions a tag
const code = 'error: Expected <div> to be closed before </span>';
assert.strictEqual(cleanProviderError(code), code);

// A bare page with no prefix still reads cleanly
const bare = cleanProviderError('<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body></body></html>');
assert.ok(bare.startsWith('HTML error page ("502 Bad Gateway")'), bare);
assert.ok(bare.endsWith('KB of HTML omitted]'), bare);

// Very long visible text is cut, not dumped
const long = cleanProviderError(`<!DOCTYPE html><html><title>t</title><body>${'word '.repeat(500)}</body></html>`);
assert.ok(long.includes('word word') && /\[\d KB of HTML omitted\]$/.test(long), long);
assert.ok(long.length < 400, `cut failed (${long.length})`);

console.log('error-text.check: OK');
