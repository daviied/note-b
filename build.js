// Bundles the web clients into public/build and copies KaTeX's stylesheet and
// fonts into public/katex. `--watch` rebuilds on change.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: { pc: 'web/pc/main.js', tablet: 'web/tablet/main.js' },
  bundle: true,
  format: 'esm',
  splitting: true, // the math editor (MathLive) loads only when first used
  chunkNames: 'chunks/[name]-[hash]',
  outdir: 'public/build',
  minify: !watch,
  sourcemap: true,
  target: ['es2020', 'safari15'],
  logLevel: 'info',
};

// KaTeX: CSS + woff2 fonts (every current browser uses woff2; the CSS lists it first)
const katexDist = path.join('node_modules', 'katex', 'dist');
fs.mkdirSync('public/katex/fonts', { recursive: true });
fs.copyFileSync(path.join(katexDist, 'katex.min.css'), 'public/katex/katex.min.css');
for (const f of fs.readdirSync(path.join(katexDist, 'fonts'))) {
  if (f.endsWith('.woff2')) fs.copyFileSync(path.join(katexDist, 'fonts', f), path.join('public/katex/fonts', f));
}

// MathLive (Desmos-style math typing): its fonts
const mathliveFonts = path.join('node_modules', 'mathlive', 'fonts');
fs.mkdirSync('public/mathlive/fonts', { recursive: true });
for (const f of fs.readdirSync(mathliveFonts)) fs.copyFileSync(path.join(mathliveFonts, f), path.join('public/mathlive/fonts', f));
fs.rmSync('public/build', { recursive: true, force: true }); // drop chunks from older builds

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
