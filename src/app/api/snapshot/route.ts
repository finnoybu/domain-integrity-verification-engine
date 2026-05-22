import { NextRequest, NextResponse } from "next/server";
import { promises as dns } from "dns";
import tls from "tls";
import { DomainSnapshot, getCanonicalBase, persistSnapshot, isValidDomain, canSnapshotDomain } from "@/lib/storage";
import {
  badRequest,
  enforceRateLimit,
  getRequestId,
  internalError,
  licenseLimitReached,
  logServerError,
  notFound,
} from "@/lib/api-helpers";

interface ExtendedPeerCertificate extends tls.PeerCertificate {
  subjectaltname?: string;
}

interface RdapResponse {
  handle?: string;
  port43?: string;
  ldhName?: string;
  secureDNS?: {
    delegationSigned?: boolean;
  };
  entities?: Array<{
    objectClassName: string;
    handle?: string;
    roles?: string[];
    publicIds?: Array<{
      type: string;
      identifier: string;
    }>;
    vcardArray?: Array<Array<string | Array<string | unknown>>>;
  }>;
  nameservers?: Array<{ ldhName?: string }>;
  status?: string[];
  events?: Array<{ eventAction: string; eventDate: string }>;
}

interface IpRdapResponse {
  handle?: string;
  name?: string;
  country?: string;
}

async function fetchRdapData(domain: string): Promise<Partial<DomainSnapshot>> {
  const result: Partial<DomainSnapshot> = {};

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeoutId);

    if (response && response.ok) {
      const data: RdapResponse = await response.json();

      // Extract registrar and IANA ID from entities
      if (data.entities) {
        for (const entity of data.entities) {
          // Look for entity with "registrar" role
          if (
            entity.objectClassName === "entity" &&
            entity.roles &&
            entity.roles.includes("registrar")
          ) {
            // Extract registrar name from vcardArray
            if (entity.vcardArray && Array.isArray(entity.vcardArray)) {
              // vcardArray format: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Registrar Name"], ...]]
              const vcardEntries = entity.vcardArray[1];
              if (Array.isArray(vcardEntries)) {
                for (const entry of vcardEntries) {
                  if (Array.isArray(entry) && entry.length >= 4) {
                    // Look for "fn" (formatted name) or "org" (organization)
                    if (entry[0] === "fn" || entry[0] === "org") {
                      result.registrar = String(entry[3]);
                      break;
                    }
                  }
                }
              }
            }
            
            // Extract IANA ID from publicIds array
            if (entity.publicIds) {
              for (const publicId of entity.publicIds) {
                if (publicId.type === "IANA Registrar ID") {
                  result.registrarIanaId = publicId.identifier;
                  break;
                }
              }
            }
            break;
          }
        }
      }

      // Extract DNSSEC status from RDAP
      if (data.secureDNS?.delegationSigned !== undefined) {
        result.dnssec = data.secureDNS.delegationSigned;
      }

      // Extract nameservers
      if (data.nameservers && data.nameservers.length > 0) {
        result.nameservers = data.nameservers
          .filter((ns) => ns.ldhName)
          .map((ns) => ns.ldhName!);
      }

      // Extract status
      if (data.status) {
        result.status = data.status;
      }

      // Extract dates from events
      if (data.events) {
        for (const event of data.events) {
          if (event.eventAction === "registration") {
            result.created = event.eventDate;
          } else if (event.eventAction === "expiration") {
            result.expires = event.eventDate;
          } else if (event.eventAction === "last changed" || event.eventAction === "lastUpdate") {
            result.lastUpdated = event.eventDate;
          }
        }
      }
    }
  } catch (error) {
    console.error(`RDAP fetch error for ${domain}:`, error);
  }

  return result;
}

async function fetchDnsData(domain: string): Promise<Partial<DomainSnapshot>> {
  const result: Partial<DomainSnapshot> = {};

  try {
    // Resolve A records
    try {
      result.aRecords = await dns.resolve4(domain);
    } catch {
      // Silent fail - domain may not have A records
    }

    // Resolve AAAA records
    try {
      result.aaaaRecords = await dns.resolve6(domain);
    } catch {
      // Silent fail - domain may not have AAAA records
    }

    // Resolve MX records
    try {
      const mxRecords = await dns.resolveMx(domain);
      result.mxRecords = mxRecords.map((mx) => `${mx.priority} ${mx.exchange}`);
    } catch {
      // Silent fail
    }

    // Resolve TXT records
    try {
      const txtRecords = await dns.resolveTxt(domain);
      result.txtRecords = txtRecords.map((txt) => txt.join(""));
      
      // Parse SPF record from TXT records
      for (const txt of result.txtRecords) {
        if (txt.startsWith("v=spf1")) {
          result.spfRecord = txt;
          break;
        }
      }
    } catch {
      // Silent fail
    }

    // Lookup DMARC record
    try {
      const dmarcRecords = await dns.resolveTxt(`_dmarc.${domain}`);
      for (const dmarcRecord of dmarcRecords) {
        const dmarcText = dmarcRecord.join("");
        if (dmarcText.includes("v=DMARC1")) {
          result.dmarcRecord = dmarcText;
          break;
        }
      }
    } catch {
      // Silent fail - no DMARC record
    }

    // Resolve SOA records
    try {
      const soaRecords = await dns.resolveSoa(domain);
      if (soaRecords) {
        result.soa = {
          primaryNs: soaRecords.nsname,
          hostmaster: soaRecords.hostmaster,
          serial: soaRecords.serial,
          refresh: soaRecords.refresh,
          retry: soaRecords.retry,
          expire: soaRecords.expire,
          minimum: soaRecords.minttl,
        };
      }
    } catch {
      // Silent fail
    }

    // Note: nameservers might already be set from RDAP, but try DNS too
    if (!result.nameservers) {
      try {
        result.nameservers = await dns.resolveNs(domain);
      } catch {
        // Silent fail
      }
    }

    // Check DNSSEC via DS records if not already set from RDAP
    if (result.dnssec === undefined) {
      try {
        await dns.resolve(domain, "DS");
        result.dnssec = true;
      } catch {
        result.dnssec = false;
      }
    }
  } catch (error) {
    console.error(`DNS fetch error for ${domain}:`, error);
  }

  return result;
}

async function fetchSslData(domain: string): Promise<Partial<DomainSnapshot>> {
  const result: Partial<DomainSnapshot> = {};

  try {
    const certificate = await new Promise<ExtendedPeerCertificate>((resolve, reject) => {
      const socket = tls.connect(443, domain, { servername: domain }, function () {
        const cert = socket.getPeerCertificate() as ExtendedPeerCertificate;
        socket.destroy();
        if (cert && Object.keys(cert).length > 0) {
          resolve(cert);
        } else {
          reject(new Error("No certificate"));
        }
      });

      socket.on("error", reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("Timeout"));
      });
    });

    result.httpsReachable = true;

    // Extract SSL issuer
    if (certificate.issuer?.O) {
      result.sslIssuer = Array.isArray(certificate.issuer.O)
        ? certificate.issuer.O[0]
        : certificate.issuer.O;
    } else if (certificate.issuer?.CN) {
      result.sslIssuer = Array.isArray(certificate.issuer.CN)
        ? certificate.issuer.CN[0]
        : certificate.issuer.CN;
    }

    // Extract SSL subject
    if (certificate.subject?.CN) {
      result.sslSubject = Array.isArray(certificate.subject.CN)
        ? certificate.subject.CN[0]
        : certificate.subject.CN;
    } else if (certificate.subject?.O) {
      result.sslSubject = Array.isArray(certificate.subject.O)
        ? certificate.subject.O[0]
        : certificate.subject.O;
    }

    // Extract valid from date
    if (certificate.valid_from) {
      result.sslValidFrom = certificate.valid_from;
    }

    // Extract valid to date
    if (certificate.valid_to) {
      result.sslExpires = certificate.valid_to;
    }

    // Extract Subject Alternative Names (SANs)
    if (certificate.subjectaltname) {
      const sanArray = certificate.subjectaltname.split(", ").map((san: string) => san.trim());
      result.sslSans = sanArray;
    }

    // Extract certificate fingerprint (prefer SHA256)
    if (certificate.fingerprint256) {
      result.sslFingerprint = certificate.fingerprint256;
    } else if (certificate.fingerprint) {
      result.sslFingerprint = certificate.fingerprint;
    }
  } catch (error) {
    console.error(`SSL fetch error for ${domain}:`, error);
    result.httpsReachable = false;
  }

  return result;
}

async function fetchIpRdapData(ip: string): Promise<{ asn?: string; asnName?: string; hostingProvider?: string; ipCountry?: string }> {
  const result: { asn?: string; asnName?: string; hostingProvider?: string; ipCountry?: string } = {};

  // Query Team Cymru IP-to-ASN mapping service via DNS
  try {
    const octets = ip.split('.');
    if (octets.length === 4) {
      const reversedIp = octets.reverse().join('.');
      const cymruDomain = `${reversedIp}.origin.asn.cymru.com`;
      
      const txtRecords = await dns.resolveTxt(cymruDomain).catch(() => []);
      if (txtRecords.length > 0) {
        // Format: "ASN | IP Prefix | Country | RIR | Allocation Date"
        const recordParts = txtRecords[0].join('').split('|').map(s => s.trim());
        if (recordParts.length >= 1 && recordParts[0]) {
          result.asn = `AS${recordParts[0]}`;
        }
      }
    }
  } catch (error) {
    console.error(`Team Cymru ASN lookup error for ${ip}:`, error);
  }

  // Query ARIN RDAP for organization name, hosting provider, and country
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`https://rdap.arin.net/registry/ip/${ip}`, {
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeoutId);

    if (response && response.ok) {
      const data: IpRdapResponse = await response.json();

      // Extract organization name
      if (data.name) {
        result.asnName = data.name;
        result.hostingProvider = data.name;
      }

      // Extract country
      if (data.country) {
        result.ipCountry = data.country;
      }
    }
  } catch (error) {
    console.error(`IP RDAP fetch error for ${ip}:`, error);
  }

  return result;
}

async function fetchInfrastructureData(domain: string): Promise<Partial<DomainSnapshot>> {
  const result: Partial<DomainSnapshot> = {};

  try {
    // Attempt to get A and AAAA records
    let aRecords: string[] = [];
    let aaaaRecords: string[] = [];
    
    try {
      aRecords = await dns.resolve4(domain);
    } catch {
      // Silent fail
    }

    try {
      aaaaRecords = await dns.resolve6(domain);
    } catch {
      // Silent fail
    }

    // Populate ipAddresses with combined A + AAAA records
    result.ipAddresses = [...aRecords, ...aaaaRecords];

    // Query IP RDAP for first available IP
    if (result.ipAddresses.length > 0) {
      const ip = result.ipAddresses[0];

      try {
        const ipRdapData = await fetchIpRdapData(ip);
        
        if (ipRdapData.asn) {
          result.asn = ipRdapData.asn;
        }
        
        if (ipRdapData.asnName) {
          result.asnName = ipRdapData.asnName;
        }
        
        if (ipRdapData.hostingProvider) {
          result.hostingProvider = ipRdapData.hostingProvider;
        }
        
        if (ipRdapData.ipCountry) {
          result.ipCountry = ipRdapData.ipCountry;
        }
      } catch (error) {
        console.error(`IP RDAP lookup error:`, error);
      }

      // CDN Detection based on hosting provider
      if (result.hostingProvider) {
        const hostingProviderLower = result.hostingProvider.toLowerCase();
        const cdnProviders = ["cloudflare", "fastly", "akamai", "cloudfront"];
        result.cdnDetected = cdnProviders.some((cdn) => hostingProviderLower.includes(cdn));
      } else {
        result.cdnDetected = false;
      }
    }
  } catch (error) {
    console.error(`Infrastructure fetch error for ${domain}:`, error);
  }

  return result;
}

async function createSnapshot(domain: string): Promise<DomainSnapshot> {
  const timestamp = new Date().toISOString();

  // Start from canonical base with all fields present
  const snapshot = getCanonicalBase(domain, timestamp);

  // Fetch data from all sources in parallel
  const [rdapData, dnsData, sslData, infrastructureData] = await Promise.all([
    fetchRdapData(domain),
    fetchDnsData(domain),
    fetchSslData(domain),
    fetchInfrastructureData(domain),
  ]);

  // Merge all fetched data into canonical base
  Object.assign(snapshot, rdapData, dnsData, sslData, infrastructureData);

  return snapshot;
}

export async function POST(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const { domain, action } = await request.json();

    if (!domain) {
      return badRequest("Domain is required", requestId);
    }

    const normalizedDomain = domain.toLowerCase().trim();

    if (action === "delete") {
      const { deleteDomain } = await import("@/lib/storage");
      const success = await deleteDomain(normalizedDomain);

      if (!success) {
        return notFound("Domain not found", requestId);
      }

      return NextResponse.json({ success: true, message: "Domain deleted" });
    }

    // Default action: create/update snapshot and persist to disk.
    // Enforce the licensed domain capacity before any network work.
    const access = await canSnapshotDomain(normalizedDomain);
    if (!access.allowed) {
      return licenseLimitReached(access.reason, requestId);
    }

    // Check whether the domain is valid
    const valid = await isValidDomain(normalizedDomain);
    
    const snapshot = await createSnapshot(normalizedDomain);
    
    // Only persist if domain is valid
    if (valid) {
      await persistSnapshot(normalizedDomain, snapshot);
    }

    return NextResponse.json(snapshot, { status: 201 });
  } catch (error) {
    logServerError(requestId, "Snapshot API error", error);
    return internalError("Failed to create snapshot", requestId);
  }
}

export async function GET(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const { getDomainSnapshot, getDomainAccess } = await import("@/lib/storage");
    const access = await getDomainAccess();
    const allDomains = [...access.active, ...access.frozen];

    const domainsList = await Promise.all(
      allDomains.map(async (domain) => {
        const snapshot = await getDomainSnapshot(domain);
        return { domain, snapshot, active: access.active.includes(domain) };
      })
    );

    return NextResponse.json({
      domains: domainsList,
      license: {
        licensed: access.license.licensed,
        tier: access.license.tier,
        domainLimit: access.limit,
        expires: access.license.expires,
        expired: access.license.expired,
        reason: access.license.reason,
      },
    });
  } catch (error) {
    logServerError(requestId, "GET snapshot error", error);
    return internalError("Failed to fetch domains", requestId);
  }
}
