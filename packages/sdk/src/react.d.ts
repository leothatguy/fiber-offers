import type { SignedFiberOffer } from "@fiber-offers/protocol";

export interface OfferQRProps {
  offerId: string;
  resolverUrl: string;
  payload?: "link" | "offer";
  paymentLink?: string;
  size?: number;
  className?: string;
}

export interface RecurringApprovalProps {
  offer: SignedFiberOffer;
  onApprove?: () => void;
  onRevoke?: () => void;
  approved?: boolean;
  className?: string;
}

export function OfferQR(props: OfferQRProps): any;
export function RecurringApproval(props: RecurringApprovalProps): any;
