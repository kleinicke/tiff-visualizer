import { measureAll } from './statistics.js';
import type { Calibration, MeasurementProvenance, MeasurementRow, MeasurementSource, Roi } from './types.js';

interface ResultsHost {
  getSource(): MeasurementSource | null;
  getCalibration(): Calibration;
  getRois(): Roi[];
  provenance(): MeasurementProvenance;
  extraColumns(): Record<string, string>;
  changed(): void;
}
interface CollectedResult {
  rows: MeasurementRow[];
  provenance: MeasurementProvenance;
  extraColumns: Record<string, string>;
}

/** Measurement scheduling and per-file provenance, independent of panel markup. */
export class MeasurementResults {
  rows: MeasurementRow[] = [];
  collecting = false;
  collected = new Map<string, CollectedResult>();
  channelMode: 'first' | 'all' = 'first';
  private frame = 0;
  constructor(private host: ResultsHost) {}
  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.measure();
      this.host.changed();
    });
  }
  measure(): void {
    const source = this.host.getSource();
    if (!source) { this.rows = []; return; }
    const channels = this.channelMode === 'all' ? Array.from({ length: source.channels || 1 }, (_, index) => index) : [0];
    this.rows = measureAll(this.host.getRois(), source, this.host.getCalibration(), channels);
    if (this.collecting && source.fileName && this.rows.length) {
      this.collected.set(source.fileName, { rows: this.rows.map(row => ({ ...row })),
        provenance: this.host.provenance(), extraColumns: this.host.extraColumns() });
    }
  }
  getRows(): MeasurementRow[] { return this.rows; }
  exportRows(): MeasurementRow[] { return this.collecting ? [...this.collected.values()].flatMap(item => item.rows) : this.rows; }
  snapshotFor(row: MeasurementRow): CollectedResult | undefined { return row.fileName ? this.collected.get(row.fileName) : undefined; }
}
