"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { generateBatch, type BatchResult } from "@/app/actions/batch";
import { Card, CardHeader, Field, inputClass, btn, Badge } from "@/components/ui";

const SEGMENTS = [
  ["", "Any segment"],
  ["vehicle_motorcycle", "Vehicle & motorcycle"],
  ["appliances_electronics", "Appliances & electronics"],
  ["supermarket_retail", "Supermarket & retail"],
  ["furniture_interior", "Furniture & interior"],
  ["bank_financial", "Banks & financial"],
  ["corporate_hq", "Corporate headquarters"],
  ["wellness_leisure", "Wellness & leisure"],
] as const;

export function BatchPanel({ candidateCount }: { candidateCount: number }) {
  const router = useRouter();
  const [count, setCount] = useState(5);
  const [segment, setSegment] = useState("");
  const [result, setResult] = useState<BatchResult | null>(null);
  const [pending, start] = useTransition();

  function run() {
    start(async () => {
      const r = await generateBatch(count, segment || undefined);
      setResult(r);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader
        title="Generate drafts in bulk"
        subtitle="Drafting only. Every message still has to be reviewed and approved one at a time."
        action={<Badge>{candidateCount} ready</Badge>}
      />

      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="How many">
            <input
              type="number"
              min={1}
              max={10}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className={`${inputClass} max-w-24`}
            />
          </Field>

          <Field label="Segment">
            <select
              value={segment}
              onChange={(e) => setSegment(e.target.value)}
              className={`${inputClass} max-w-56`}
            >
              {SEGMENTS.map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </Field>

          <button
            disabled={pending || candidateCount === 0}
            onClick={run}
            className={btn.primary}
          >
            {pending ? "Generating…" : "Generate"}
          </button>
        </div>

        <p className="text-xs text-[var(--color-muted)]">
          Picks the highest-scoring prospects that have a segment, an email
          address and no draft yet. Ten at a time at most — generation is
          sequential and the provider rate-limits bursts.
        </p>

        {result && (
          <div className="space-y-2">
            <p
              role="status"
              className={`rounded-md px-3 py-2 text-sm ${
                result.ok
                  ? "bg-emerald-50 text-emerald-800"
                  : "bg-[var(--color-danger-bg)] text-[var(--color-alam-red)]"
              }`}
            >
              {result.message}
              {result.remaining > 0 && result.succeeded > 0 && (
                <> {result.remaining} candidate(s) remain.</>
              )}
            </p>

            {result.items.length > 0 && (
              <ul className="divide-y divide-[var(--color-line)] rounded-md border border-[var(--color-line)]">
                {result.items.map((item) => (
                  <li
                    key={item.prospectId}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <span className="font-medium text-[var(--color-ink)]">
                      {item.draftId ? (
                        <Link href={`/drafts/${item.draftId}`} className="hover:underline">
                          {item.company}
                        </Link>
                      ) : item.company}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-[var(--color-muted)]">{item.message}</span>
                      {item.ok
                        ? (item.needsReview
                            ? <Badge tone="warn">needs review</Badge>
                            : <Badge tone="ok">created</Badge>)
                        : <Badge tone="danger">failed</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
