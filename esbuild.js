const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/dts-linter.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: !production,
    platform: 'node',
    outfile: 'dist/dts-linter.js',
    external: [],
    logLevel: 'silent',
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin
    ]
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await generateLicensesWithTempDeps()
    await ctx.dispose();
  }
}


// Manual blacklist of exact package names to ignore (removes their dependencies too)
const blacklist = [
	'@types/node',
  'devicetree-language-server-types',
  'esbuild',
  'ts-node',
  'typescript',
  'vscode-languageserver-types',
  'license-checker'
	// Add more packages here if needed
];


/**
 * Generate THIRD_PARTY_LICENSES.txt excluding blacklisted packages and their dependencies
 */
function generateLicensesWithTempDeps() {
	const pkgPath = path.join(__dirname, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

	// 1. Move allowed devDependencies to dependencies temporarily
	const allowedDevDeps = {};
	for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
		if (!blacklist.includes(name)) {
			allowedDevDeps[name] = version;
		}
	}

  const prevDependecies = {...(pkg.dependencies || {})}
	pkg.dependencies = {...(pkg.dependencies || {})}
	Object.assign(pkg.dependencies, allowedDevDeps);

	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

	try {
		// 2. Run license-checker on production dependencies only
		execSync(
			'npx license-checker --json --production > .licenses.tmp.json',
			{
				stdio: 'inherit',
				cwd: __dirname,
			},
		);
	} finally {
		// 3. Restore original package.json
    pkg.dependencies = prevDependecies;
		Object.assign(pkg.dependencies, prevDependecies); // Restore prev temporary dependencies  
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
	}

	// 4. Read licenses
	const licenses = JSON.parse(
		fs.readFileSync(path.join(__dirname, '.licenses.tmp.json'), 'utf8'),
	);
	fs.unlinkSync(path.join(__dirname, '.licenses.tmp.json'));

	// 5. Build THIRD_PARTY_LICENSES.txt
	let output = 'THIRD-PARTY LICENSES\n\n';
	for (const [pkgName, info] of Object.entries(licenses)) {
		output += `${pkgName}\n`;
		output += `License: ${info.licenses}\n`;
		if (info.repository) output += `Repository: ${info.repository}\n`;
		if (info.licenseText) output += `\n${info.licenseText.trim()}\n`;
		output += '\n' + '-'.repeat(70) + '\n\n';
	}

	// 6. Write to server/dist/THIRD_PARTY_LICENSES.txt
	const outFile = path.join(__dirname, 'dist/THIRD_PARTY_LICENSES.txt');
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, output, 'utf8');
	console.log(`✅ THIRD_PARTY_LICENSES.txt written to ${outFile}`);
}


/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  }
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});