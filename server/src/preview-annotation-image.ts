// Injected into the same lexical scope as the annotation runtime; captures a bounded, sanitized layout immediately.
export function previewAnnotationImageRuntime(): string {
  return String.raw`
  const captureImage = (entry) => {
    const capturedAt = entry.data.context.capturedAt;
    const missing = ['输入值、Canvas、Shadow DOM、登录态不在 DOM 序列化保证范围内',
      '外部图片、字体、伪元素、动画和超出 500 个节点的内容可能缺失'];
    const finish = (dataUrl) => {
      entry.image = { capturedAt, ...(dataUrl ? { dataUrl } : {}), missing };
      if (entry.committed) send({ type: 'image', id: entry.data.id, image: entry.image });
    };
    try {
      const snapshot = entry.data.context, width = Math.min(snapshot.viewport.width, 1920), height = Math.min(snapshot.viewport.height, 1920);
      let budget = 500;
      const walk = (node) => {
        if (--budget < 0) return '';
        if (nodeType(node) === 3) return htmlEscape(clean(textOf(node), 500));
        if (nodeType(node) !== 1 || node === host) return '';
        const name = tag(node);
        if (skip(node) || matches(/^(canvas|svg|img|video|audio|link|meta|head)$/, name)) return '';
        const styles = computed(node);
        if (cssValue(styles, 'display') === 'none') return '';
        let style = '';
        for (const key of ['display','position','top','left','right','bottom','width','height','box-sizing','padding','margin',
          'color','background-color','font-family','font-size','font-weight','line-height','border','border-radius','gap',
          'flex-direction','flex-wrap','align-items','justify-content','grid-template-columns','overflow','transform','opacity']) {
          const value = clean(cssValue(styles, key), 160);
          if (!matches(/url\s*\(/i, value)) style += key + ':' + value + ';';
        }
        let body = '';
        for (const child of childrenOf(node)) { body += walk(child); if (budget < 0) break; }
        return '<div style="' + htmlEscape(style) + '">' + body + '</div>';
      };
      const content = walk(document.body);
      if (budget < 0) missing[missing.length] = '页面节点超过预算，部分内容未绘制';
      if (width !== snapshot.viewport.width || height !== snapshot.viewport.height) missing[missing.length] = '视口裁切至最大 1920 像素';
      const xml = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%">'
        + '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + snapshot.viewport.width + 'px;transform:translate('
        + (-snapshot.scroll.x) + 'px,' + (-snapshot.scroll.y) + 'px)">' + content + '</div></foreignObject></svg>';
      const img = create('img');
      let done = false;
      const finishOnce = (url) => { if (done) return; done = true; finish(url); };
      img.onload = () => {
        try {
          const canvas = create('canvas'); canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0);
          const result = canvas.toDataURL('image/png');
          if (result.length > 2800000) { missing[missing.length] = '图像过大，未保存'; finishOnce(); }
          else finishOnce(result);
        } catch { missing[missing.length] = '浏览器拒绝页面转图'; finishOnce(); }
      };
      img.onerror = () => { missing[missing.length] = '页面转图失败'; finishOnce(); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      window.setTimeout(() => { if (!done) { missing[missing.length] = '页面转图超时'; finishOnce(); } }, 3000);
    } catch { missing[missing.length] = '页面无法转图'; finish(); }
  };
  `;
}
