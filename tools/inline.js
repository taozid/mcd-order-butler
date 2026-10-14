#!/usr/bin/env node
/**
 * 把引擎、示例菜单、示例画像内联进 app/template.html，产出零依赖单文件 app/index.html
 *   node tools/inline.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const engine = fs.readFileSync(path.join(root, 'engine', 'order-butler.js'), 'utf8');
const menu = fs.readFileSync(path.join(root, 'samples', 'menu.json'), 'utf8');
const profile = fs.readFileSync(path.join(root, 'config', 'profile.example.json'), 'utf8');
const tpl = fs.readFileSync(path.join(root, 'app', 'template.html'), 'utf8');

const out = tpl
  .replace('<!--INJECT_ENGINE-->', '<script>\n' + engine + '\n</script>')
  .replace('<!--INJECT_DATA-->',
    '<script>\nwindow.__MENU__ = ' + menu + '.items;\nwindow.__PROFILE__ = ' + profile + ';\n</script>');

const dest = path.join(root, 'app', 'index.html');
fs.writeFileSync(dest, out, 'utf8');
console.log('已生成 ' + path.relative(root, dest) + '（' + (out.length / 1024).toFixed(1) + ' KB，零外部依赖）');
