/* native.build — syntax highlighting and scroll reveals. No dependencies. */
(() => {
  'use strict';

  const KW = {
    java: ['abstract','assert','boolean','break','byte','case','catch','char','class','const',
      'continue','default','do','double','else','enum','extends','final','finally','float','for',
      'if','implements','import','instanceof','int','interface','long','native','new','package',
      'private','protected','public','return','short','static','strictfp','super','switch',
      'synchronized','this','throw','throws','transient','try','void','volatile','while','true',
      'false','null','var','record','sealed','permits','yield'],
    cpp: ['alignas','alignof','auto','bool','break','case','catch','char','class','const',
      'constexpr','continue','decltype','default','delete','do','double','else','enum','explicit',
      'export','extern','false','float','for','friend','goto','if','inline','int','long','mutable',
      'namespace','new','noexcept','nullptr','operator','private','protected','public','return',
      'short','signed','sizeof','static','struct','switch','template','this','throw','true','try',
      'typedef','typename','union','unsigned','using','virtual','void','volatile','while'],
    c: ['auto','break','case','char','const','continue','default','do','double','else','enum',
      'extern','float','for','goto','if','inline','int','long','register','restrict','return',
      'short','signed','sizeof','static','struct','switch','typedef','union','unsigned','void',
      'volatile','while','_Bool'],
    kotlin: ['as','break','class','continue','do','else','false','for','fun','if','import','in',
      'interface','is','null','object','package','return','super','this','throw','true','try',
      'typealias','val','var','when','while','by','get','set','internal','private','protected',
      'public','open','override','abstract','final','const','lateinit','data','sealed','enum',
      'companion','init','plugins','dependencies']
  };

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const TOKENS = new RegExp([
    /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/.source,          // 1 comment
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.source,  // 2 string / char
    /(^[ \t]*#[a-zA-Z]+|@[A-Za-z_][\w.]*)/.source,   // 3 preprocessor / annotation
    /(\b\d[\w.]*\b)/.source,                         // 4 number
    /([A-Za-z_$][\w$]*)/.source                      // 5 identifier
  ].join('|'), 'gm');

  function highlight (src, lang) {
    const words = new Set(KW[lang] || KW.java);
    let out = '', last = 0, m;
    TOKENS.lastIndex = 0;
    while ((m = TOKENS.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1])      out += `<span class="tok-com">${esc(m[1])}</span>`;
      else if (m[2]) out += `<span class="tok-str">${esc(m[2])}</span>`;
      else if (m[3]) out += `<span class="tok-ann">${esc(m[3])}</span>`;
      else if (m[4]) out += `<span class="tok-num">${esc(m[4])}</span>`;
      else if (m[5]) {
        const w = m[5];
        if (words.has(w))            out += `<span class="tok-kw">${esc(w)}</span>`;
        else if (/^[A-Z_][A-Za-z0-9_]*$/.test(w) && w.length > 1)
                                     out += `<span class="tok-type">${esc(w)}</span>`;
        else                         out += esc(w);
      }
    }
    out += esc(src.slice(last));
    return out;
  }

  document.querySelectorAll('code[data-lang]').forEach((el) => {
    el.innerHTML = highlight(el.textContent, el.dataset.lang);
  });

  /* --------------------------------------------------------- reveals */

  const targets = document.querySelectorAll(
    '.section > .kicker, .section > h2, .section > .prose, .stat, .case, .cell, .coords, .single'
  );

  if ('IntersectionObserver' in window &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    targets.forEach((el) => el.classList.add('reveal'));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.06 });
    targets.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------- hero scroll cue */

  const cue = document.querySelector('.scroll-cue');
  if (cue) {
    window.addEventListener('scroll', () => {
      const f = Math.max(0, 1 - window.scrollY / 320);
      cue.style.opacity = String(f);
    }, { passive: true });
  }
})();
