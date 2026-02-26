import fs from "fs";
import { stringify } from "csv-stringify/sync";

export async function writeCsvResults(results, outPath) {
  const records = results.map((r) => ({
    row_number: r.row_number ?? "",
    citation_id: r.citation_id ?? "",
    reading_list_id: r.reading_list_id ?? "",
    reading_list_name: r.reading_list_name ?? "",
    course_code: r.course_code ?? "",
    section: r.section ?? "",
    citation_type: r.citation_type ?? "",

    input_url: r.input_url ?? "",
    final_url: r.final_url ?? "",

    http_status: r.http_status ?? "",

    identity_mode: r.identity_mode ?? "",

    expected_title: r.expected_title ?? "",
    expected_author: r.expected_author ?? "",
    expected_journal_title: r.expected_journal_title ?? "",
    expected_publisher: r.expected_publisher ?? "",
    expected_issn: r.expected_issn ?? "",
    expected_isbn: r.expected_isbn ?? "",

    observed_title: r.observed_title ?? "",
    content_type: r.content_type ?? "",
    text_length: r.text_length ?? "",

    classification: r.classification ?? "",
    match_confidence: r.match_confidence ?? "",
    title_match_score: r.title_match_score ?? "",
    paywall_detected: r.paywall_detected ?? "",
    matched_fields: Array.isArray(r.matched_fields) ? r.matched_fields.join("|") : "",
    paywall_signals: Array.isArray(r.paywall_signals) ? r.paywall_signals.join("|") : "",

    resolver_clicks: r.resolver_clicks ?? "",
    resolver_chain: r.resolver_chain ? JSON.stringify(r.resolver_chain) : "",

    issue_summary: r.issue_summary ?? "",
    recommended_action: r.recommended_action ?? "",

    gemini_error: r.gemini_error ?? "",

    extraction_error: r.extraction_error ?? "",
    screenshot: r.screenshot ?? ""
  }));

  const csv = stringify(records, { header: true });
  fs.writeFileSync(outPath, csv, "utf-8");
}
