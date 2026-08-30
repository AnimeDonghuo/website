import { useEffect, useState } from 'react';
import { Icon } from './Icons.jsx';

export default function DeliveryDialog({ item, onClose }) {
  const [copied, setCopied] = useState(false);
  const ready = Boolean(item?.deliveryReady && item?.telegramUrl);

  useEffect(() => {
    function onKeydown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeydown);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeydown);
      document.body.style.overflow = originalOverflow;
    };
  }, [onClose]);

  async function copyLink() {
    if (!item?.telegramUrl) return;
    try {
      await navigator.clipboard.writeText(item.telegramUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  if (!item) return null;

  return (
    <div className="delivery-dialog" role="presentation" onMouseDown={onClose}>
      <section className="delivery-dialog__card" role="dialog" aria-modal="true" aria-labelledby="delivery-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="delivery-dialog__close" type="button" onClick={onClose} aria-label="Close delivery dialog"><Icon name="close" size={19} /></button>
        <div className="delivery-dialog__stamp"><Icon name="telegram" size={21} /></div>
        <p className="eyebrow">TELEGRAM DELIVERY</p>
        <h2 id="delivery-title">Get <em>{item.title}</em> in the bot</h2>
        <p className="delivery-dialog__intro">Files are delivered privately by the catalog bot. The website never stores your media files.</p>

        <ol className="delivery-steps">
          <li><span>1</span><p><strong>Open the delivery bot</strong><br />Telegram verifies the link and opens a private chat.</p></li>
          <li><span>2</span><p><strong>Tap Start</strong><br />The bot prepares the available release files from its storage channel.</p></li>
          <li><span>3</span><p><strong>Receive the files</strong><br />Everything arrives directly in your Telegram chat.</p></li>
        </ol>

        {ready ? (
          <>
            <a className="button button--telegram button--wide" href={item.telegramUrl} target="_blank" rel="noreferrer">
              <Icon name="telegram" size={20} /> Open secure delivery <Icon name="external" size={16} />
            </a>
            <button className="copy-link" type="button" onClick={copyLink}>
              <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Delivery link copied' : 'Copy delivery link'}
            </button>
          </>
        ) : (
          <div className="delivery-dialog__setup">
            <Icon name="info" size={20} />
            <p><strong>Demo catalog item.</strong> Add your bot username and storage channel in the server environment to enable its delivery link.</p>
          </div>
        )}
        <p className="delivery-dialog__note"><Icon name="shield" size={14} /> Only share material you own or are authorized to distribute.</p>
      </section>
    </div>
  );
}
