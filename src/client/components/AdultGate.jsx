import { useNavigate } from 'react-router-dom';
import { Icon } from './Icons.jsx';

/**
 * A deliberately small, route-level consent prompt. Catalog data is held back
 * by the API until its confirm action succeeds; this component only presents
 * the visitor choice and never receives an adult release record itself.
 */
export default function AdultGate({ onConfirm, confirming = false, error = null }) {
  const navigate = useNavigate();

  return (
    <section className="adult-gate" aria-labelledby="adult-gate-title">
      <div className="adult-gate__backdrop" aria-hidden="true" />
      <div className="adult-gate__dialog" role="alertdialog" aria-modal="true" aria-labelledby="adult-gate-title" aria-describedby="adult-gate-copy">
        <span className="adult-gate__badge" aria-hidden="true">18+</span>
        <p className="eyebrow"><span /> AGE CONFIRMATION</p>
        <h1 id="adult-gate-title">This collection is for <em>adults only.</em></h1>
        <p id="adult-gate-copy">Please confirm that you are 18 years of age or older to enter the 18+ collection. Choosing No will take you back to the main catalog.</p>
        {error ? <p className="adult-gate__error" role="alert"><Icon name="info" size={16} /> {error}</p> : null}
        <div className="adult-gate__actions">
          <button className="button button--primary" type="button" onClick={onConfirm} disabled={confirming}>
            {confirming ? 'Confirming…' : 'I am 18+'} <Icon name="arrow" size={17} />
          </button>
          <button className="button button--secondary" type="button" onClick={() => navigate('/', { replace: true })} disabled={confirming}>
            No, go back
          </button>
        </div>
        <p className="adult-gate__fine-print">Your confirmation is kept only for this browser session.</p>
      </div>
    </section>
  );
}
