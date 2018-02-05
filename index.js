const {Analyzer, PackageUrlResolver, InMemoryOverlayUrlLoader, Severity} = require('polymer-analyzer');
const RequestShortener = require('webpack/lib/RequestShortener');
const {ScannedImport, ScannedInlineDocument} = require('polymer-analyzer/lib/model/model');
const {AnalysisContext} = require('polymer-analyzer/lib/core/analysis-context');
const Uri = require('vscode-uri').default;
const {DomModule} = require('polymer-analyzer/lib/polymer/dom-module-scanner');
const {PolymerElement} = require('polymer-analyzer/lib/polymer/polymer-element');
const path = require('path');

/**
 * Caching + loading wrapper around _parseContents.
 * 
 * Overwrite so that mime type isn't based off file extension
 */
AnalysisContext.prototype._parse = async function(resolvedUrl) {
  return this._cache.parsedDocumentPromises.getOrCompute(resolvedUrl, async () => {
    const content = await this.load(resolvedUrl);
    // const extension = path.extname(resolvedUrl).substring(1);
    return this._parseContents('js', content, resolvedUrl);
  });
};

class WebpackRequireImport {
  constructor(modulePathsById) {
    this.modulePathsById = modulePathsById;
  }

  async scan(document, visit) {
    const imports = [];
    const self = this;

    const myVisitor = {
      enterCallExpression(node, parent) {
        if (!(node.callee.type === 'Identifier' && node.callee.name === '__webpack_require__')) {
          return;
        }

        if (!(parent.type == 'ExpressionStatement' ||
            (parent.type == 'VariableDeclarator' && parent.id.type == 'Identifier'))) {
          return;
        }

        const modulePath = self.modulePathsById.get(node.arguments[0].value);
        imports.push(new ScannedImport(
          'js-import',
          modulePath,
          document.sourceRangeForNode(node),
          document.sourceRangeForNode(node.callee),
          parent.id,
          true));
      }
    };
    await visit(myVisitor);
    return {features: imports, warnings: []};
  }
}

class PolymerWebpackLoaderScanner {
  async scan(document, visit) {
    const features = [];

    const myVisitor = {
      enterCallExpression(node, parent) {
        if (!(
            node.callee.type === 'MemberExpression' &&
            node.callee.object.type === 'Identifier' &&
            node.callee.object.name === 'RegisterHtmlTemplate' &&
            (node.callee.property.name === 'register' || node.callee.property.name === 'toBody') &&
            node.arguments.length === 1)) {
          return;
        }

        const sourceRangeForLiteral = document.sourceRangeForNode(node.arguments[0]);
        const sourceRangeForContents = {
          file: sourceRangeForLiteral.file,
          start: {
            line: sourceRangeForLiteral.start.line,
            column: sourceRangeForLiteral.start.column + 1
          },
          end: {
            line: sourceRangeForLiteral.end.line,
            column: sourceRangeForLiteral.end.column - 1
          }
        };

        let commentText;
        if (node.leadingComments != null) {
          commentText = node.leadingComments.map((c) => c.value).join('\n');
        } else {
          commentText = '';
        }

        features.push(new ScannedInlineDocument('html', node.arguments[0].value, {
          filename: sourceRangeForContents.file,
          col: sourceRangeForContents.start.column,
          line: sourceRangeForContents.start.line
        }, commentText, sourceRangeForContents, { language: 'js', node }));
      }
    };
    await visit(myVisitor);
    return {features};
  }
}

class PolymerAnalyzerPlugin {
  constructor(options, compilerFlags) {
    this.options = options || {};
  }

  apply(compiler) {
    this.requestShortener = new RequestShortener(compiler.context);

    compiler.plugin('compilation', (compilation, params) => {
      if (compilation.compiler.parentCompilation) {
        return;
      }

      compilation.plugin('additional-assets', async (cb) => {
        const modulePathsById = new Map();
        const loader = new InMemoryOverlayUrlLoader();
        compilation.chunks.forEach(chunk => this.getChunkSources(chunk, modulePathsById, loader));
        const scanners = AnalysisContext.getDefaultScanners();
        scanners.get('js').push(new WebpackRequireImport(modulePathsById));
        scanners.get('js').push(new PolymerWebpackLoaderScanner());
        const analyzer = new Analyzer({
          urlLoader: loader,
          urlResolver: new PackageUrlResolver({packageDir: '/'}),
          scanners
        });
        const entryFilePaths = [];
        compilation.entries.forEach(entry => {
          let entryModules = entry.userRequest ? [entry] : entry.dependencies.map(dep => dep.module);
          entryModules.forEach(entryModule => {
            entryFilePaths.push(entryModule.userRequest.substr(1));
          });
        });
        
        const analysis = await analyzer.analyze(entryFilePaths);
        const data = {
          features: new Set(),
          htmlDocuments: new Map()
        };

        analysis.getFeatures().forEach(feature => {
          // do something
        });
       
        cb();
      });
    });
  }

  getChunkSources(chunk, modulePathsById, loader) {
    if (chunk.isEmpty()) {
      return;
    }

    const addModule = (webpackModule) => {
      if (modulePathsById.has(webpackModule.id)) {
        return;
      }
      try {
        let path = Uri.file(webpackModule.userRequest).toString();
        modulePathsById.set(webpackModule.id, path);
        const souceAndMap = webpackModule.source().sourceAndMap();
        loader.urlContentsMap.set(path, souceAndMap.source);
      } catch (e) {
        console.error(e);
      }
    };

    return chunk
      .getModules()
      .forEach(webpackModule => {
        if (!webpackModule.userRequest) {
          webpackModule.dependencies.forEach(depModule => addModule(depModule.module));
        } else {
          addModule(webpackModule);
        }
      });
  }
}

module.exports = PolymerRenamePlugin;
