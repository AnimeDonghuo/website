import { useEffect, useState } from 'react';
import { Icon } from './Icons.jsx';

function fileHeading(file) {
  return file?.episode?.label || file?.label || `Delivery file ${file?.position || ''}`.trim();
}

function fileMeta(file) {
  return [file?.quality, file?.size, file?.kind].filter(Boolean).join(' · ');
}

export default function DeliveryDialog({ item, files = [], title, episodeLabel, onClose }) {
  const [copied, setCopied] = useState(false);
  const selectedFiles = Array.isArray(files) ? files : [];
  const hasSpecificFiles = selectedFiles.length > 0;
  const deliveryHref = hasSpecificFiles ? null : item?.deliveryUrl || item?.telegramUrl;
  const ready = Boolean(item?.deliveryReady && deliveryHref);
  const specificReady = selectedFiles.some((file) => file?.deliveryReady && (file.deliveryUrl || file.telegramUrl));
  const dialogTitle = title || item?.title || 'files';

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
    if (!deliveryHref) return;
    const shareableLink = deliveryHref.startsWith('/') ? new URL(deliveryHref, window.location.origin).href : deliveryHref;
    try {
      await navigator.clipboard.writeText(shareableLink);
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
        <h2 id="delivery-title">Get <em>{dialogTitle}</em> in the bot</h2>
        <p className="delivery-dialog__intro">{hasSpecificFiles
          ? `${episodeLabel || 'This Watch option'} has ${selectedFiles.length} matching file${selectedFiles.length === 1 ? '' : 's'} below. Each link delivers only that selected file.`
          : `${item.episodeCount ? `${item.episodeCount} indexed episode${item.episodeCount === 1 ? '' : 's'} and ` : ''}files are delivered privately by the catalog bot. The website never stores your media files.`}</p>

        <ol className="delivery-steps">
          <li><span>1</span><p><strong>Open the delivery bot</strong><br />Telegram verifies the link and opens a private chat.</p></li>
          <li><span>2</span><p><strong>Tap Start</strong><br />The bot prepares the available release files from its storage channel.</p></li>
          <li><span>3</span><p><strong>Receive the files</strong><br />Everything arrives directly in your Telegram chat.</p></li>
        </ol>

        {hasSpecificFiles ? (
          specificReady ? <div className="delivery-file-list" aria-label="Matching episode files">
            {selectedFiles.map((file) => {
              const href = file?.deliveryUrl || file?.telegramUrl;
              const heading = fileHeading(file);
              const meta = fileMeta(file);
              return file?.deliveryReady && href ? <a className="delivery-file-link" key={file.id || file.position || heading} href={href} target="_blank" rel="noreferrer" aria-label={`Get ${heading} on Telegram`}>
                <span><strong>{heading}</strong>{meta ? <small>{meta}</small> : null}</span>
                <b><Icon name="telegram" size={16} /> Get file</b>
              </a> : <div className="delivery-file-link delivery-file-link--unavailable" key={file.id || file.position || heading}>
                <span><strong>{heading}</strong>{meta ? <small>{meta}</small> : null}</span>
                <b>Unavailable</b>
              </div>;
            })}
          </div> : <div className="delivery-dialog__setup">
            <Icon name="info" size={20} />
            <p><strong>Delivery is not configured for these files.</strong> Add your bot username and storage channel in the server environment to enable their private links.</p>
          </div>
        ) : ready ? (
          <>
            <a className="button button--telegram button--wide" href={deliveryHref} target="_blank" rel="noreferrer">
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
