'use client';

import { useParams } from 'next/navigation';
import { MaterialsBrowser } from '@/components/materials/MaterialsBrowser';
import { decodeMaterialsSegments } from '@/lib/materials-folder-tree';

export default function MaterialsFolderPage() {
  const params = useParams<{ subcategory: string[] }>();
  const parts = decodeMaterialsSegments(params.subcategory);
  return <MaterialsBrowser parts={parts.length === 1 && parts[0] === 'catalog' ? [] : parts} />;
}
