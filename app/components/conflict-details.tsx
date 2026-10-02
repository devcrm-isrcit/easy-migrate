import { useRef, useState } from "react";
import { Button, Icon, Modal, Pill } from "./easy-migrate-ui";
import type {
  MetafieldConflict,
  MetaobjectComparisonItem,
} from "../lib/definition-sync/types.shared";

/*
 * Info button for the "Conflicts Detected" banner. Opens a dialog listing
 * every metafield and metaobject field whose type differs between the stores.
 */
export function ConflictDetailsButton({
  metafieldConflicts,
  metaobjectConflicts,
}: {
  metafieldConflicts: MetafieldConflict[];
  metaobjectConflicts: MetaobjectComparisonItem[];
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const metaobjectFieldCount = metaobjectConflicts.reduce(
    (count, item) => count + item.fieldConflicts.length,
    0,
  );
  const total = metafieldConflicts.length + metaobjectFieldCount;

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="em-icon-btn em-banner__info"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Show conflict details"
        title="Show conflict details"
      >
        <Icon name="info" size={18} />
      </button>

      {open ? (
        <Modal
          title={`${String(total)} ${total === 1 ? "conflict" : "conflicts"}`}
          onClose={close}
          footer={<Button onClick={close}>Close</Button>}
        >
          <p className="em-body-sm">
            These already exist on the destination store with a different
            type. Easy Migrate skips them so nothing is overwritten.
          </p>

          {metafieldConflicts.length > 0 ? (
            <section className="em-conflict-group">
              <h4 className="em-label-caps">
                {`Metafields (${String(metafieldConflicts.length)})`}
              </h4>
              <ul className="em-conflict-list">
                {metafieldConflicts.map((conflict) => (
                  <li key={conflict.key} className="em-conflict-item">
                    <div className="em-conflict-item__head">
                      <span className="em-body em-strong">
                        {conflict.source.name}
                      </span>
                      <Pill tone="outline">{conflict.source.ownerType}</Pill>
                    </div>
                    <span className="em-code em-conflict-item__key">
                      {`${conflict.source.namespace}.${conflict.source.key}`}
                    </span>
                    <TypeComparison
                      source={conflict.source.type}
                      target={conflict.target.type}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {metaobjectFieldCount > 0 ? (
            <section className="em-conflict-group">
              <h4 className="em-label-caps">
                {`Metaobject fields (${String(metaobjectFieldCount)})`}
              </h4>
              <ul className="em-conflict-list">
                {metaobjectConflicts
                  .filter((item) => item.fieldConflicts.length > 0)
                  .map((item) => (
                    <li key={item.type} className="em-conflict-item">
                      <div className="em-conflict-item__head">
                        <span className="em-body em-strong">
                          {item.source.name}
                        </span>
                        <Pill tone="outline">METAOBJECT</Pill>
                      </div>
                      <span className="em-code em-conflict-item__key">
                        {item.type}
                      </span>
                      <ul className="em-conflict-fields">
                        {item.fieldConflicts.map((conflict) => (
                          <li key={conflict.key} className="em-conflict-field">
                            <span className="em-body-sm em-strong">
                              {conflict.source.name}
                            </span>
                            <span className="em-code em-conflict-item__key">
                              {conflict.source.key}
                            </span>
                            <TypeComparison
                              source={conflict.source.type}
                              target={conflict.target.type}
                            />
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}

function TypeComparison({ source, target }: { source: string; target: string }) {
  return (
    <dl className="em-conflict-types">
      <dt className="em-body-sm">Source</dt>
      <dd>
        <code className="em-code-chip">{source}</code>
      </dd>
      <dt className="em-body-sm">Destination</dt>
      <dd>
        <code className="em-code-chip em-code-chip--critical">{target}</code>
      </dd>
    </dl>
  );
}
