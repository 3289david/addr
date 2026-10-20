// Legal pages. Text is parameterised by /v1/legal (operator identity, retention periods) so that what is published
// matches what the server actually does. These are drafts to be reviewed by the operator's counsel before launch.
import { h, mount, alert, api, btn, field, skeleton, toast, navigate, run } from "./lib.js";

const DOCS = [
  ["terms", "Terms of Service"], ["privacy", "Privacy Policy"], ["privacy-ko", "개인정보 처리방침"], ["acceptable-use", "Acceptable Use"],
  ["refunds", "Payments and Refunds"], ["risks", "Risk Disclosure"], ["name-policy", "Name Policy"], ["cookies", "Cookies"], ["report", "Report a name"],
];

const op = (L) => L.entity || "[Operator legal name]";
const contact = (L) => L.email || "[contact email]";

function terms(L) {
  return [
    ["p", `These terms govern your use of the ADDR website, API, SDK and related services (the "Service"), provided by ${op(L)}${L.address ? `, ${L.address}` : ""} ("we", "us"). By using the Service you agree to them. If you do not agree, do not use it. You must be at least 18 years old and able to enter a binding contract.`],
    ["h", "1. What the Service is"],
    ["p", "ADDR is a naming system. Names ending in .addr are recorded in smart contracts on a public blockchain. The Service provides a website and API to search, register and resolve names, and tools for developers and businesses. We do not hold your funds or private keys, we are not a bank, exchange, wallet provider, broker or payment institution, and we do not provide financial, legal or tax advice."],
    ["h", "2. Names are registry entries, not property or endorsements"],
    ["ul", [
      "A name is a record in the registry contract assigned to a blockchain address for a fixed term. Registering it gives you the technical right to control that record while it is active. It is not ownership of any trademark, domain name or other right, and it does not give you any right against third parties.",
      "Ownership and records are enforced by the contract, not by us. We cannot reassign, seize or edit a live name, and we cannot reverse a blockchain transaction.",
      "A name that expires passes through a 30 day grace period and then becomes available to anyone. Expired names stop resolving.",
      "A name resolving to an address does not mean the person behind it is who you think. Always verify recipients yourself.",
    ]],
    ["h", "3. Accounts"],
    ["p", "Registering, resolving and sending by name need no account. The developer and enterprise consoles need one. You sign in with your email address and a one-time code. You are responsible for your mailbox, for keeping API keys secret and for activity under your account. Tell us promptly at " + contact(L) + " if a key or mailbox is compromised."],
    ["h", "4. Your wallet and your responsibilities"],
    ["ul", [
      "You are solely responsible for your wallet, keys, seed phrases, recovery settings, the addresses you publish and every transaction you sign. ADDR cannot recover lost keys.",
      "Check the network, asset, token standard and full address before you send. Blockchain transfers are final.",
      "You are responsible for network fees, for complying with the laws that apply to you (including tax, sanctions and anti-money-laundering rules), and for the content of your records and profile.",
    ]],
    ["h", "5. Fees and payments"],
    ["p", "Prices are shown before you pay and are read from the registrar contract. Payments are made in cryptocurrency and are governed by the Payments and Refunds policy. Plan subscriptions run for 30 days per payment and do not renew automatically."],
    ["h", "6. Acceptable use"],
    ["p", "You must follow the Acceptable Use policy and the Name Policy. We may rate-limit, suspend or revoke API keys and accounts, and remove names from our website, search and API listings, if you break them or if required by law. Because names live on a blockchain, we cannot delete a name from the registry itself."],
    ["h", "7. API and developer terms"],
    ["ul", [
      "Free and paid plans have the request limits shown in the console. We may change limits with reasonable notice and may throttle abusive traffic immediately.",
      "Do not use the API to build a competing copy of the index by brute-force enumeration beyond your plan, or to attack, overload or probe the Service.",
      "The API is an index and cache. Ownership and record data on the blockchain is authoritative. For critical decisions read the contracts directly.",
      "Enterprise customers who issue names to their own customers are responsible for the terms they give those customers and for the personal data they send us (see the Privacy Policy, section on enterprise data).",
    ]],
    ["h", "8. Intellectual property"],
    ["p", "The Service, website and documentation are ours or our licensors'. The smart contracts and reference code may be published under the licence stated in the repository. You keep the rights to content you submit and give us a limited licence to display it as needed to run the Service (for example, profile text you publish on-chain is public anyway)."],
    ["h", "9. No warranty"],
    ["p", "The Service is provided \"as is\" and \"as available\". We do not promise that it will be uninterrupted, error-free or secure, that smart contracts are free of defects (they have not necessarily been audited), that any wallet or exchange will support .addr names, or that a name will keep any particular value. Some jurisdictions do not allow certain disclaimers; they apply only to the extent permitted."],
    ["h", "10. Limitation of liability"],
    ["p", "To the maximum extent permitted by law, we are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, lost funds, lost data or loss of goodwill, including losses caused by your own errors, wrong or changed addresses, phishing, look-alike names, blockchain or network failures, third-party wallets and services, or smart-contract bugs. Our total liability for any claim relating to the Service is limited to the amount you paid us in the 12 months before the event, or USD 100 if you paid nothing. Nothing in these terms limits liability that cannot be limited by law, including liability for intent or gross negligence and mandatory consumer protections."],
    ["h", "11. Suspension and termination"],
    ["p", "You may stop using the Service and delete your account at any time from the developer console. We may suspend or end access to the website, API and consoles for breach, risk or legal reasons. Your on-chain names remain yours under the contract rules."],
    ["h", "12. Changes"],
    ["p", "We may update these terms. We will post the new version here with a new effective date and, for material changes, notify account holders by email at least 14 days ahead. Continued use after the effective date means acceptance."],
    ["h", "13. Governing law and disputes"],
    ["p", `These terms are governed by the laws of ${L.jurisdiction}, without regard to conflict-of-law rules, and subject to any mandatory consumer law of the place where you live. Courts of ${L.jurisdiction} have jurisdiction, except where mandatory law gives you the right to sue in your home courts. Please contact us first at ${contact(L)} so we can try to resolve the issue informally.`],
    ["h", "14. Contact"],
    ["p", `${op(L)}${L.representative ? `, represented by ${L.representative}` : ""}. ${L.address ? L.address + ". " : ""}Email: ${contact(L)}.`],
  ];
}

function privacy(L) {
  const r = L.retentionDays;
  return [
    ["p", `This policy explains what personal data ${op(L)} ("we") handles when you use ADDR, why, for how long, and what rights you have. Privacy contact: ${L.privacyEmail || contact(L)}.`],
    ["h", "1. The short version"],
    ["ul", [
      "Searching, resolving names and sending to names needs no account and no personal data from you.",
      "Names, address records and transactions are public on a blockchain. We cannot delete or hide them.",
      "If you sign in to the developer console we keep your email address and what is needed to run your account.",
      "We do not use advertising or analytics trackers, and we do not sell personal data.",
    ]],
    ["h", "2. Data we handle, and why"],
    ["ul", [
      "Email address: to create your account and send sign-in codes and security or service notices. Legal basis: performance of the contract, and our legitimate interest in securing accounts.",
      "Sign-in codes and one-time links: stored as hashes, only to verify you. Deleted after " + r.loginCodes + " days.",
      "Session data: a random session identifier (stored as a hash), your browser's user-agent text (shortened) and timestamps, to keep you signed in and let you end sessions. Kept until the session expires plus " + r.sessionsAfterExpiry + " days.",
      "API keys: we store a hash and a short prefix, a label you choose, scopes and last-used time. We cannot read the key after it is created.",
      "Usage counters: number of requests and errors per key per day, to enforce plan limits and show you analytics.",
      "Network address (IP) for abuse prevention: we use it only to rate-limit sign-in, free-name claims, reports and anonymous API use. It is hashed together with the current date, so it cannot be linked across days. Rate-limit records are deleted after " + r.rateEvents + " days; anonymous per-IP usage counters after " + r.ipUsage + " days. We do not keep web server access logs of visitors' IP addresses.",
      "Account configuration: webhook URLs (and the signing secrets we generate), claimed namespaces and wallet addresses you link, and invoices you create. Wallet addresses and names you publish on-chain are public by nature.",
      "Enterprise data: if you issue names to your own customers, you send us customer identifiers and wallet addresses. For that data you are the controller and we act as your processor, only on your instructions, to run the Service.",
      "Reports you submit about a name: the category, text and the contact detail you choose to give. Closed reports are deleted after " + Math.round(r.closedReports / 365) + " years.",
      "Invoices and payment records: amounts, network, transaction id and status, kept as long as accounting and consumer law require. After you delete your account they are retained without any link to your email.",
      "Email delivery records: recipient, subject, status and error text for " + r.mailLog + " days. The message body (which contains the one-time code) is blanked after " + r.sentMailBodies + " days.",
      "Audit log of account and administrative actions, kept " + r.audit + " days. Webhook delivery logs " + r.webhookDeliveries + " days.",
    ]],
    ["h", "3. Data in your browser"],
    ["p", "The website stores some things only in your browser: a session cookie after sign-in, your theme choice, and, if you use the Send page, your receipts and address book. These never leave your browser unless you export them. You can clear them in the app (Send, Receipts and address book) or in your browser settings."],
    ["h", "4. Who else sees data"],
    ["ul", [
      "Blockchain nodes and the public: everything you do on-chain is public and permanent.",
      "Blockchain RPC providers: your browser connects to the RPC endpoint shown by the site to read the chain and send transactions, so that provider can see your IP address and requests. In manual wallet mode you can use your own wallet and node.",
      "Our servers query public blockchain and price data sources (for example block explorers and a price API) to verify payments and quote prices. Those requests do not contain your personal data.",
      "Email: sign-in emails are delivered directly to your email provider's mail servers, which necessarily see the message.",
      "Hosting: the Service runs on infrastructure operated by " + (L.hosting || "[hosting provider and region]") + ".",
      "Authorities: we disclose data when legally required and strictly to the extent required.",
      "We do not sell personal data and do not share it for advertising.",
    ]],
    ["h", "5. International transfers"],
    ["p", "Your data may be processed in the country where our servers are located and where the blockchain network operates, which can differ from where you live. Where required, we rely on appropriate safeguards or on your consent."],
    ["h", "6. Your rights"],
    ["p", `Depending on where you live (including under Korea's Personal Information Protection Act and the EU/UK GDPR) you can ask to access, correct, delete, restrict or port your data, and object to processing. In the developer console (Account) you can download everything we hold about your account as JSON and delete your account. Deletion removes your user record, sessions, API keys, webhooks, claimed namespaces and issued-name records, and your sign-in emails. Email ${L.privacyEmail || contact(L)} for anything else; we answer within 30 days. You may complain to your data protection authority (in Korea: the Personal Information Protection Commission).`],
    ["h", "7. Security"],
    ["p", "Sign-in codes, session tokens and API keys are stored only as hashes. Cookies are HttpOnly and SameSite. State-changing requests carry a CSRF token. Webhook payloads are signed. Access to administrative functions is restricted and logged. No system is perfectly secure; tell us at " + contact(L) + " if you find a vulnerability."],
    ["h", "8. Children"],
    ["p", "The Service is not for people under 18 and we do not knowingly collect their data. If you believe a child gave us data, contact us and we will delete it."],
    ["h", "9. Changes and contact"],
    ["p", `We will post changes here with a new effective date and email account holders about material changes. Contact: ${L.privacyEmail || contact(L)}${L.address ? `, ${L.address}` : ""}.`],
  ];
}

function privacyKo(L) {
  const r = L.retentionDays;
  const o = L.entity || "[운영자 법인명]";
  return [
    ["p", `${o}(이하 "회사")는 ADDR 서비스 제공과 관련하여 「개인정보 보호법」 등 관련 법령에 따라 이용자의 개인정보를 보호하고, 이와 관련한 고충을 신속하게 처리하기 위해 다음과 같이 개인정보 처리방침을 수립·공개합니다.`],
    ["h", "1. 처리하는 개인정보 항목과 처리 목적"],
    ["ul", [
      "필수: 이메일 주소 - 개발자 콘솔 계정 생성, 로그인(일회용 코드 발송), 보안·서비스 공지.",
      "자동 생성·수집: 세션 식별자(해시 저장), 브라우저 user-agent(일부), 접속 일시, API 키(해시와 앞부분 표시), API 요청 횟수·오류 횟수.",
      "부정 이용 방지: 접속 IP 주소는 로그인·무료 이름 신청·신고·비로그인 API 호출의 횟수 제한에만 사용하며, 당일 날짜와 결합한 해시값으로만 처리하여 날짜를 넘어 식별할 수 없습니다. 웹 서버 접속 로그에 방문자 IP를 보관하지 않습니다.",
      "서비스 이용 과정에서 이용자가 입력하는 정보: 웹훅 URL, 연동 지갑 주소, 네임스페이스, 청구서(인보이스) 내역, 신고 내용 및 이용자가 남긴 연락처.",
      "엔터프라이즈 고객이 자신의 고객 식별자·지갑 주소를 입력하는 경우 해당 정보에 대해 고객이 개인정보처리자이고 회사는 수탁자로서 고객의 지시 범위에서만 처리합니다.",
      "블록체인에 기록되는 이름·주소 레코드·거래 내역은 공개 정보이며 회사가 삭제할 수 없습니다.",
    ]],
    ["h", "2. 처리 및 보유 기간"],
    ["ul", [
      `로그인 코드·링크: 해시로 저장, ${r.loginCodes}일 후 파기.`,
      `세션: 만료 후 ${r.sessionsAfterExpiry}일 후 파기.`,
      `횟수 제한 기록: ${r.rateEvents}일 후 파기. 비로그인 IP별 사용량 카운터: ${r.ipUsage}일 후 파기.`,
      `이메일 발송 기록(수신자·제목·상태): ${r.mailLog}일. 본문(일회용 코드 포함): 발송 후 ${r.sentMailBodies}일 후 삭제.`,
      `감사 로그: ${r.audit}일. 웹훅 전송 기록: ${r.webhookDeliveries}일. 종료된 신고: ${Math.round(r.closedReports / 365)}년.`,
      "청구서·결제 기록: 「전자상거래 등에서의 소비자보호에 관한 법률」 등 관계 법령이 정한 기간(대금결제 및 재화 등의 공급에 관한 기록 5년) 동안 보관하며, 회원 탈퇴 시 이메일 등 개인을 식별할 수 있는 정보와의 연결을 제거합니다.",
      "회원 탈퇴 시 계정 정보(이메일, 세션, API 키, 웹훅, 네임스페이스, 발급 이름 기록)는 지체 없이 파기합니다.",
    ]],
    ["h", "3. 개인정보의 제3자 제공 및 처리위탁"],
    ["p", "회사는 이용자의 개인정보를 제3자에게 판매하거나 광고 목적으로 제공하지 않습니다. 법령에 근거한 수사기관 등의 적법한 요청이 있는 경우에 한하여 필요한 범위에서 제공할 수 있습니다. 서비스 운영을 위한 인프라 사업자: " + (L.hosting || "[호스팅 사업자 및 소재 국가]") + ". 로그인 메일은 이용자의 메일 서비스 제공자 서버로 직접 전송됩니다."],
    ["h", "4. 개인정보의 국외 이전"],
    ["p", "서버 소재지와 블록체인 네트워크의 특성상 개인정보가 국외에서 처리·보관될 수 있습니다. 이전 국가, 항목, 일시, 방법, 이전받는 자의 정보는 위 호스팅 정보와 이 방침에 따르며, 법령이 요구하는 경우 별도 동의를 받습니다."],
    ["h", "5. 개인정보의 파기 절차 및 방법"],
    ["p", "보유 기간이 지났거나 처리 목적이 달성된 개인정보는 지체 없이 파기합니다. 전자적 파일은 복구할 수 없는 방법으로 삭제합니다. 보관 기간이 정해진 정보는 별도 분리하여 해당 기간 보관 후 파기합니다."],
    ["h", "6. 이용자의 권리와 행사 방법"],
    ["p", `이용자는 언제든지 자신의 개인정보에 대한 열람, 정정, 삭제, 처리정지, 이동을 요구할 수 있습니다. 개발자 콘솔의 '계정' 메뉴에서 보유 정보를 JSON으로 내려받고 회원 탈퇴를 직접 할 수 있으며, 그 밖의 요청은 ${L.privacyEmail || L.email || "[이메일]"}로 보내 주시면 30일 이내에 처리합니다. 만 14세 미만 아동과 만 18세 미만은 서비스 대상이 아닙니다.`],
    ["h", "7. 쿠키 및 브라우저 저장소"],
    ["p", "로그인 유지를 위한 필수 세션 쿠키(addr_session, HttpOnly)만 사용하며 광고·분석용 쿠키는 사용하지 않습니다. 테마 설정, 송금 영수증, 주소록은 이용자의 브라우저에만 저장되고 서버로 전송되지 않습니다."],
    ["h", "8. 안전성 확보조치"],
    ["p", "로그인 코드·세션·API 키 해시 저장, HttpOnly/SameSite 쿠키, CSRF 방어, 웹훅 서명, 관리자 접근 제한 및 감사 기록, 개인정보 보관 기간 자동 파기 작업 등을 시행합니다."],
    ["h", "9. 개인정보 보호책임자 및 고충 처리"],
    ["p", `개인정보 보호책임자: ${L.representative || "[성명/직책]"} / 이메일 ${L.privacyEmail || L.email || "[이메일]"} / ${L.address || "[주소]"}. 기타 침해 신고·상담: 개인정보침해신고센터(privacy.kisa.or.kr, 118), 개인정보 분쟁조정위원회(kopico.go.kr, 1833-6972), 대검찰청 사이버수사과(spo.go.kr, 1301), 경찰청 사이버수사국(ecrm.police.go.kr, 182).`],
    ["h", "10. 방침의 변경"],
    ["p", `이 방침은 ${L.effective}부터 적용됩니다. 내용이 변경되는 경우 시행 7일 전(중요한 변경은 30일 전)부터 서비스 화면과 이메일로 알립니다.`],
  ];
}

function acceptable(L) {
  return [
    ["p", "These rules apply to the website, API and consoles. Reports go to " + contact(L) + " or the report form."],
    ["h", "You may not"],
    ["ul", [
      "Register, publish or use names or records to impersonate a person, company, project or service, to deceive people into sending funds, or to run phishing, scams, rug pulls or fraud.",
      "Use look-alike names to confuse people about who they are paying, or hold a name you know infringes another's trademark in order to extort or mislead.",
      "Publish content that is illegal, sexually exploits minors, incites violence, harasses, or doxxes people, including in profile fields.",
      "Use the Service for money laundering, sanctions evasion, terrorism financing or any other unlawful activity, or if you are subject to sanctions that prohibit it.",
      "Attack or overload the Service, probe it for weaknesses outside a good-faith disclosure, bypass rate limits or quotas, share or resell API keys, or scrape beyond your plan.",
      "Send spam or unsolicited email through the sign-in system, or use another person's email address to sign in.",
      "Abuse the free-name offer by automating wallet creation or evading the per-wallet and rate limits.",
    ]],
    ["h", "What we may do"],
    ["p", "Warn you, rate-limit, revoke API keys, suspend accounts, flag a name in search and the app as reported, remove it from our listings and API responses, and cooperate with lawful requests. We cannot delete or reassign a name on the blockchain. Good-faith security research reported privately to us will not be pursued."],
  ];
}

function refunds(L) {
  return [
    ["p", "How payments work and when money comes back."],
    ["h", "1. What you pay"],
    ["ul", [
      "Name registration and renewal. The price in USD is shown before you pay and is read from the registrar contract. First names of 5+ characters per wallet are free; you still pay network fees.",
      "Developer plans (Startup, Business). Prices are in Korean won and charged in cryptocurrency at the quoted rate. Each payment buys 30 days. There is no automatic renewal and we never charge a stored payment method.",
    ]],
    ["h", "2. Paying on the registry chain"],
    ["p", "When you register or renew from your wallet, payment and registration happen in one transaction: if it fails, nothing is registered and the contract returns your payment (you lose only the network fee). Overpayments in ETH are refunded automatically by the contract in the same transaction."],
    ["h", "3. Paying with other coins (invoices)"],
    ["ul", [
      "An invoice quotes an exact amount, valid for a short time (shown on the invoice). Send exactly that amount in one transaction to the address shown, then submit the transaction id.",
      "We read the transaction from the network and register after the required confirmations. Network fees are yours.",
      "If you send less than quoted, send to the wrong address or asset, or pay twice, the payment is not applied. Contact us with the invoice id and transaction id. Where we hold the funds because of our own error or duplicate payment we refund them, less network fees, to the sending address, normally within 14 days.",
      "If you pay after the quote expired, we review the payment: we either complete the order at the original price if the name is still available, or refund.",
      "If the name was registered by someone else before we could register it for you, the invoice ends as failed and we refund the payment.",
    ]],
    ["h", "4. When we do not refund"],
    ["p", "Registrations and renewals that were completed on-chain are final because the contract cannot reverse them, except where the law gives you a right of withdrawal or where we made an error. Plan days already used are not refunded. Price changes (including market rate moves) after payment do not entitle you to a refund. Funds sent to a wrong address you typed, or on the wrong network, cannot be recovered by us."],
    ["h", "5. Your statutory rights"],
    ["p", "Nothing here limits mandatory consumer rights where you live, including cancellation rights for digital services that apply before the service has been delivered. Because name registration is performed immediately at your request, any right of withdrawal ends once it is performed, to the extent the law allows."],
    ["h", "6. How to ask"],
    ["p", `Email ${contact(L)} with the invoice id and transaction id. Refunds are paid in the same asset on the same network when possible; we may ask you to confirm the receiving address by signing a message.`],
  ];
}

function risks(L) {
  return [
    ["p", "Using blockchain systems carries real risk. Read this before you rely on ADDR."],
    ["ul", [
      ["Irreversible transfers. ", "A transaction sent to a wrong or malicious address, or on the wrong network, usually cannot be recovered."],
      ["Address changes and hijacks. ", "An owner (or anyone who steals their key) can change a name's addresses at any time. ADDR warns about changes in the last 24 hours and differences from what you saw before; it cannot prove a change is legitimate."],
      ["Look-alike names. ", "Names such as paypa1 and paypal look alike. Check the exact spelling and, for large amounts, send a small test first and confirm with the recipient on another channel."],
      ["What \"verified\" means. ", "The address is well-formed and read from the chain for an active name. It says nothing about who owns it or whether it can receive funds or tokens."],
      ["Expiry. ", "Names expire. After the 30 day grace period anyone can register them and then control where payments to that name go. Renew in time."],
      ["Lost or stolen keys. ", "There is no automatic recovery. A guardian can only be set by you in advance. Whoever holds the owner key controls the name."],
      ["Smart-contract risk. ", "The contracts may contain bugs and have not necessarily been independently audited. Admin changes (prices, reserved words) go through a public timelock, but a flaw could still cause losses."],
      ["Network and provider risk. ", "Blockchains can halt, reorganise or be congested; RPC providers, price sources and explorers can be wrong or down. Payments need several confirmations, and very large reorganisations could undo them."],
      ["Wallet support. ", "Most wallets and exchanges do not understand .addr names. Do not type a name into software that does not support it."],
      ["Price and market risk. ", "Crypto prices move. Invoice quotes are fixed only for a short time."],
      ["Legal and tax. ", "Rules about crypto assets, domain-like names, payments and taxes differ by country and change. You are responsible for your own compliance."],
    ].map(([b, t]) => b + t)],
  ];
}

function namePolicy(L) {
  return [
    ["p", "How names are chosen, protected and disputed."],
    ["h", "Format"],
    ["p", "Lowercase letters a-z, digits and hyphens; 1 to 63 characters; no leading, trailing or double hyphens; no Unicode. This is enforced by the contract."],
    ["h", "Reserved names"],
    ["p", "Some words (for example admin, support, official, wallet and the names of major chains and tokens) are reserved for protocol and ecosystem use and cannot be registered by the public. Changes to the reserved list are published through the timelock. Reserved names can never be used to take a name that is already registered."],
    ["h", "Short and premium names"],
    ["p", "Shorter names cost more (4 characters, 3, 2); one character names are not open. Premium prices are public and apply only to future registrations."],
    ["h", "Trademarks and impersonation"],
    ["ul", [
      "Registration is first come, first served and is not a trademark clearance. Registering a name does not give you rights to a brand, and a brand owner's rights are not removed by the registry.",
      "We cannot reassign or delete a registered name; the contract does not allow it. If you believe a name infringes your rights or impersonates you, use the report form with the name, proof of your rights and what you want. We may warn users, flag the name in our search, website and API, notify the owner and, for our own listings, stop showing it. You may also pursue the owner directly or through the courts.",
      "Names that clearly impersonate a person or organisation to deceive users, and that are reported with evidence, may be flagged as reported. Flags are not a legal finding.",
      "Counter-notice: the owner can respond to a report by email and ask us to review the flag.",
    ]],
    ["h", "Subnames and enterprise issuers"],
    ["p", "A platform that issues subnames such as alice.wallet.addr is responsible for the names it issues. The subname's owner (the customer wallet) controls it, can transfer it, and can make it sovereign so the issuer can no longer remove it."],
    ["h", "Reports"],
    ["p", `Use the report form, or email ${contact(L)}. Reports are triaged by category and we aim to respond within 7 days; urgent scam reports first.`],
  ];
}

function cookies(L) {
  return [
    ["p", "We use only what is needed to run the site. We do not use advertising or analytics cookies, so there is no cookie banner to accept."],
    ["h", "Cookie"],
    ["ul", ["addr_session: set when you sign in with your email. Strictly necessary, HttpOnly, SameSite=Lax, " + (L.sessionDays || 30) + " day sliding expiry. Removed when you sign out."]],
    ["h", "Browser storage"],
    ["ul", [
      "addr.theme: your light or dark choice.",
      "addr.receipts, addr.book, addr.seen.*: your sent-payment receipts, address book and last-seen addresses, so we can warn you when an address changes. Stored only in your browser.",
      "addr.myname, addr.manualAddress: convenience values you entered. Stored only in your browser.",
    ]],
    ["p", "You can delete all of this in your browser settings. Wallet extensions are separate software with their own privacy practices."],
  ];
}

const BUILDERS = { terms, privacy, "privacy-ko": privacyKo, "acceptable-use": acceptable, refunds, risks, "name-policy": namePolicy, cookies };

function render(sections) {
  return sections.map(([t, v]) => (t === "h" ? h("h2", null, v) : t === "ul" ? h("ul", null, v.map((x) => h("li", null, x))) : h("p", null, v)));
}

function nav(current) {
  return h("div", { class: "legal-nav" }, DOCS.map(([k, label]) => h("a", { class: "chip", href: `/legal/${k}`, style: k === current ? "color:var(--text);border-color:var(--accent)" : "" }, label)));
}

export async function legal(root, doc) {
  const entry = DOCS.find(([k]) => k === doc);
  if (!entry) return navigate("/legal/terms", true);
  mount(root, h("div", { class: "legal" }, skeleton(4)));
  const L = await api("GET", "/v1/legal").catch(() => ({ jurisdiction: "Republic of Korea", effective: "", retentionDays: {}, entity: "", email: "" }));
  document.title = `${entry[1]} - ADDR`;
  if (doc === "report") return mount(root, h("div", { class: "legal" }, nav(doc), reportForm()));
  const body = BUILDERS[doc](L);
  mount(root, h("div", { class: "legal" }, nav(doc),
    h("h1", null, entry[1]),
    h("div", { class: "meta" }, doc === "privacy-ko" ? `시행일: ${L.effective}` : `Effective ${L.effective}`),
    L.configured ? null : alert("warn", "Operator details are not configured on this deployment. Set LEGAL_ENTITY, LEGAL_EMAIL, LEGAL_ADDRESS (and LEGAL_REPRESENTATIVE, LEGAL_HOSTING) before launch. These pages are templates and need review by your counsel."),
    render(body)));
}

function reportForm() {
  const category = h("select", { "aria-label": "Category" }, [["impersonation", "Impersonation"], ["trademark", "Trademark or brand"], ["scam", "Scam or phishing"], ["illegal", "Illegal content"], ["abuse", "Abuse of the service"], ["other", "Other"]].map(([v, l]) => h("option", { value: v }, l)));
  const name = h("input", { placeholder: "name.addr (optional)", spellcheck: "false" });
  const details = h("textarea", { placeholder: "What is wrong, links or proof, what you want us to do.", rows: 6, maxlength: 4000, style: "font-family:var(--sans);font-size:15px" });
  const contact = h("input", { placeholder: "email or other contact (optional)", maxlength: 200 });
  const out = h("div");
  return h("div", { class: "stack" }, h("h1", null, "Report a name"), h("p", { class: "muted", style: "margin:0" }, "ADDR cannot delete or reassign a name on the blockchain, but reports let us warn users and inform the owner. See the Name Policy."),
    field("Category", category), field("Name", name), field("Details", details), field("Your contact", contact, "Optional. We use it only to follow up on this report."),
    btn("Send report", async () => {
      const r = await api("POST", "/v1/reports", { category: category.value, name: name.value.trim() || undefined, details: details.value.trim(), contact: contact.value.trim() || undefined });
      mount(out, alert("ok", h("b", null, "Report received. "), `Reference ${r.id}. ${r.note}`));
      details.value = "";
    }), out);
}
void run; void toast;
