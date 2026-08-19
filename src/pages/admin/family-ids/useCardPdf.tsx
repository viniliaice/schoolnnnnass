// Shared PDF lifecycle for family cards: build once, preview, download,
// and always revoke the blob URL.
//
// Extracted from the original AsyncPrintLink so every print path (one family,
// selected families, all filtered, by students) uses the same code — there is
// exactly one place where a card PDF is produced.

import { useCallback, useEffect, useRef, useState } from 'react';
import { pdf } from '@react-pdf/renderer';
import { FamilyCardsDocument, type CardLayout, type FamilyCardData } from '../../../lib/print/familyCards';
import { getFamilyCards } from '../../../lib/db/familyCards';

export interface UseCardPdfResult {
  busy: boolean;
  error: string | null;
  previewUrl: string | null;
  /** Card data actually returned by the server for the last build. */
  lastCards: FamilyCardData[] | null;
  buildPreview: (familyIds: string[]) => Promise<void>;
  download: (familyIds: string[]) => Promise<void>;
  closePreview: () => void;
  reset: () => void;
}

interface Options {
  layout: CardLayout;
  includeLookupList: boolean;
  /** Pre-resolved card data (parent-portal style); skips the RPC when given. */
  cards?: FamilyCardData[] | null;
}

export function useCardPdf({ layout, includeLookupList, cards }: Options): UseCardPdfResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lastCards, setLastCards] = useState<FamilyCardData[] | null>(null);
  const urlRef = useRef<string | null>(null);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // Release the object URL when the component unmounts.
  useEffect(() => revoke, [revoke]);

  const build = useCallback(async (familyIds: string[]): Promise<{ blob: Blob; data: FamilyCardData[] }> => {
    // Card content ALWAYS comes from get_family_cards (or pre-resolved data):
    // never from the RLS-scoped student list, which can omit siblings for
    // supervisors and has no parent name for office staff.
    const data = cards ?? await getFamilyCards(familyIds);
    if (data.length === 0) throw new Error('No printable families in this selection.');
    const blob = await pdf(
      <FamilyCardsDocument families={data} layout={layout} includeLookupList={includeLookupList} />
    ).toBlob();
    return { blob, data };
  }, [cards, layout, includeLookupList]);

  const buildPreview = useCallback(async (familyIds: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const { blob, data } = await build(familyIds);
      revoke();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setPreviewUrl(url);
      setLastCards(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the PDF.');
    } finally {
      setBusy(false);
    }
  }, [build, revoke]);

  const download = useCallback(async (familyIds: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const { blob, data } = await build(familyIds);
      setLastCards(data);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mbk-family-cards-${layout}-${data.length}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the PDF.');
    } finally {
      setBusy(false);
    }
  }, [build, layout]);

  const closePreview = useCallback(() => {
    revoke();
    setPreviewUrl(null);
  }, [revoke]);

  const reset = useCallback(() => {
    revoke();
    setPreviewUrl(null);
    setLastCards(null);
    setError(null);
  }, [revoke]);

  return { busy, error, previewUrl, lastCards, buildPreview, download, closePreview, reset };
}
