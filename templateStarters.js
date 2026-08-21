// templateStarters.js
// Pre-built starting layouts offered in Admin -> Template Library -> New.
// Each is real, working HTML using merge tags against fields that
// actually exist in the stock schema (Bills -> Tenant -> Landlord) — a
// genuinely usable starting point to customize, not placeholder text.
// Kept deliberately simple/hardcoded on branding (no logo, fixed A4
// layout) per the agreed v1 scope.

const GST_INVOICE_HTML = `<html>
<head>
<style>
  @page { size: A4; margin: 0; }
  body { font-family: 'DM Sans', Arial, sans-serif; font-size: 11px; color: #1a1a1a; margin: 0; padding: 18px; }
  .invoice-box { border: 1.5px solid #000; padding: 0; }

  .ll-header { text-align: center; padding: 12px 16px 10px 16px; border-bottom: 1px solid #000; }
  .ll-header .ll-name { font-size: 18px; font-weight: 700; margin: 0 0 4px 0; text-transform: uppercase; letter-spacing: 0.5px; }
  .ll-header .ll-line { font-size: 10px; margin: 1px 0; color: #333; }

  .banner { display: flex; justify-content: space-between; align-items: center; padding: 6px 16px; border-bottom: 1px solid #000; background: #f2f2f2; }
  .banner .tax-invoice-title { font-size: 13px; font-weight: 700; letter-spacing: 1px; }
  .banner .copy-type { font-size: 10px; font-weight: 600; border: 1px solid #000; padding: 2px 8px; }

  .meta-table { width: 100%; border-collapse: collapse; border-bottom: 1px solid #000; }
  .meta-table td { padding: 5px 16px; font-size: 10px; border-right: 1px solid #000; }
  .meta-table td:last-child { border-right: none; }
  .meta-table .meta-label { color: #555; display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; }
  .meta-table .meta-value { font-weight: 600; font-size: 11px; }

  .party-block { display: flex; border-bottom: 1px solid #000; }
  .party-block .party { flex: 1; padding: 8px 16px; }
  .party-block .party:first-child { border-right: 1px solid #000; }
  .party-block .party h4 { margin: 0 0 5px 0; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #555; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
  .party-block .party p { margin: 2px 0; line-height: 1.45; font-size: 10.5px; }
  .party-block .party .party-name { font-weight: 700; font-size: 12px; margin-bottom: 3px; }

  table.line-items { width: 100%; border-collapse: collapse; border-bottom: 1px solid #000; }
  table.line-items th { background: #000; color: #fff; text-align: left; padding: 6px 10px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.3px; }
  table.line-items th.num, table.line-items td.num { text-align: right; }
  table.line-items td { padding: 8px 10px; border-bottom: 1px solid #ddd; font-size: 10.5px; }
  table.line-items td.sl { width: 30px; text-align: center; }

  .totals-section { display: flex; border-bottom: 1px solid #000; }
  .amount-words { flex: 1.4; padding: 10px 16px; border-right: 1px solid #000; }
  .amount-words h5 { margin: 0 0 4px 0; font-size: 9px; text-transform: uppercase; color: #555; letter-spacing: 0.3px; }
  .amount-words p { margin: 0; font-size: 11px; font-weight: 600; font-style: italic; }
  .totals-stack { flex: 1; }
  .totals-stack table { width: 100%; border-collapse: collapse; }
  .totals-stack td { padding: 4px 16px; font-size: 10.5px; }
  .totals-stack td.label { color: #444; }
  .totals-stack td.val { text-align: right; font-weight: 600; }
  .totals-stack tr.grand-total td { border-top: 1.5px solid #000; font-size: 13px; font-weight: 700; padding-top: 7px; }

  .footer-section { display: flex; }
  .bank-details { flex: 1.4; padding: 10px 16px; border-right: 1px solid #000; }
  .bank-details h5 { margin: 0 0 5px 0; font-size: 9px; text-transform: uppercase; color: #555; letter-spacing: 0.3px; }
  .bank-details p { margin: 2px 0; font-size: 10px; line-height: 1.4; }
  .signature-block { flex: 1; padding: 10px 16px; text-align: center; }
  .signature-block .for-line { font-size: 10px; margin-bottom: 4px; }
  .signature-block img { max-height: 55px; max-width: 160px; display: block; margin: 4px auto; }
  .signature-block .sig-caption { font-size: 9.5px; color: #555; border-top: 1px solid #000; padding-top: 3px; margin-top: 4px; display: inline-block; }
</style>
</head>
<body>
  <div class="invoice-box">

    <div class="ll-header">
      <p class="ll-name">{{I_LL.LL_Display}}</p>
      <p class="ll-line">{{I_LL.LL_Address}}</p>
      <p class="ll-line">Phone: {{I_LL.LL_Phone}} &nbsp;|&nbsp; Email: {{I_LL.LL_email}}</p>
      <p class="ll-line">PAN: {{I_LL.LL_PAN}} &nbsp;|&nbsp; GSTIN: {{I_LL.LL_GSTIN}}</p>
    </div>

    <div class="banner">
      <span class="tax-invoice-title">TAX INVOICE</span>
      <span class="copy-type">ORIGINAL FOR RECIPIENT</span>
    </div>

    <table class="meta-table">
      <tr>
        <td><span class="meta-label">Invoice No.</span><span class="meta-value">{{I_SeriesNo}}</span></td>
        <td><span class="meta-label">Invoice Date</span><span class="meta-value">{{I_Date}}</span></td>
        <td><span class="meta-label">Place of Supply</span><span class="meta-value">{{I_TenantCode.T_PropCode.P_State}}</span></td>
      </tr>
    </table>

    <div class="party-block">
      <div class="party">
        <h4>Billed To</h4>
        <p class="party-name">{{I_TenantCode.T_Name}}</p>
        <p>{{I_TenantCode.T_BillingAddr}}</p>
        <p>GSTIN: {{I_TenantCode.T_GSTIN}} &nbsp;|&nbsp; PAN: {{I_TenantCode.T_PAN}}</p>
      </div>
      <div class="party">
        <h4>Property</h4>
        <p class="party-name">{{I_TenantCode.T_PropCode.P_ShortName}}</p>
        <p>{{I_TenantCode.T_PropCode.P_Address}}</p>
      </div>
    </div>

    <table class="line-items">
      <thead>
        <tr>
          <th class="sl">Sl.</th>
          <th>Description</th>
          <th>SAC</th>
          <th class="num">Taxable Value</th>
        </tr>
      </thead>
      <tbody>
        {{#each LineItems}}
        <tr>
          <td class="sl">1</td>
          <td>{{I_Description}}</td>
          <td>{{I_SAC}}</td>
          <td class="num">{{I_BaseRent}}</td>
        </tr>
        {{/each}}
      </tbody>
    </table>

    <div class="totals-section">
      <div class="amount-words">
        <h5>Amount in Words</h5>
        <p>&mdash; <!-- not yet auto-generated; see note below the template --> &mdash;</p>
      </div>
      <div class="totals-stack">
        <table>
          <tr><td class="label">Total Before Tax</td><td class="val">{{I_BaseRent}}</td></tr>
          <tr><td class="label">CGST ({{I_CGSTPC}})</td><td class="val">{{I_CGSTAmt}}</td></tr>
          <tr><td class="label">SGST ({{I_SGSTPC}})</td><td class="val">{{I_SGSTAmt}}</td></tr>
          <tr class="grand-total"><td class="label">Total</td><td class="val">{{I_TotalBill}}</td></tr>
        </table>
      </div>
    </div>

    <div class="footer-section">
      <div class="bank-details">
        <h5>Bank Details</h5>
        <p>{{I_TenantCode.T_DepositAccount.B_Detail}}</p>
        <p>A/c No: {{I_TenantCode.T_DepositAccount.B_AccountNum}}</p>
      </div>
      <div class="signature-block">
        <p class="for-line">For {{I_LL.LL_Display}}</p>
        {{I_LL.LL_Sign}}
        <span class="sig-caption">Authorized Signatory</span>
      </div>
    </div>

  </div>
</body>
</html>`;

const RENT_RECEIPT_HTML = `<html>
<head>
<style>
  body { font-family: 'DM Sans', Arial, sans-serif; font-size: 13px; color: #2a2a2a; margin: 0; padding: 40px; }
  .receipt-title { font-size: 20px; font-weight: 700; color: #1c3554; text-align: center; margin-bottom: 24px; border-bottom: 2px solid #a9812f; padding-bottom: 12px; }
  .receipt-line { margin: 10px 0; }
  .receipt-line .label { display: inline-block; width: 160px; color: #666; }
  .amount-box { margin-top: 24px; padding: 14px; background: #f4f2ea; border: 1px solid #d6d2c2; font-size: 16px; font-weight: 700; text-align: center; color: #1c3554; }
  .signature-block { margin-top: 60px; display: flex; justify-content: space-between; }
  .signature-line { border-top: 1px solid #333; width: 200px; padding-top: 6px; font-size: 11px; text-align: center; color: #555; }
</style>
</head>
<body>
  <div class="receipt-title">RENT RECEIPT</div>

  <div class="receipt-line"><span class="label">Receipt No.</span> {{BILLS_BillNum}}</div>
  <div class="receipt-line"><span class="label">Date</span> {{BILLS_BillDate}}</div>
  <div class="receipt-line"><span class="label">Received From</span> {{BILLS_ClientCode.T_Client_Name}}</div>
  <div class="receipt-line"><span class="label">Property</span> {{BILLS_ClientCode.T_Property_Code}}</div>
  <div class="receipt-line"><span class="label">Description</span> {{BILLS_Description}}</div>

  <div class="amount-box">Amount Received: {{BILLS_Total}}</div>

  <div class="signature-block">
    <div></div>
    <div class="signature-line">Authorized Signatory<br>{{BILLS_ClientCode.T_MappedTo.LL_Display}}</div>
  </div>
</body>
</html>`;

module.exports = [
  { key: 'gst_invoice', label: 'GST Invoice', htmlBody: GST_INVOICE_HTML },
  { key: 'rent_receipt', label: 'Rent Receipt', htmlBody: RENT_RECEIPT_HTML },
];
