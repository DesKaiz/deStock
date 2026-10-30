export type MapObjectType = "pallet" | "rack" | "cart" | "wall" | "aisle";

export type ProductEntry = {
  id: string;
  name: string;
  quantity: number | null;
  unit: string;
};

export type MapObject = {
  id: string;
  type: MapObjectType;
  label: string;
  x: number;
  y: number;
  width: number;
  length: number;
  rotation: number;
  products: ProductEntry[];
};

export const OBJECT_COLORS: Record<MapObjectType, string> = {
  pallet: "#d9a441",
  rack: "#4f9d69",
  cart: "#6d91d6",
  wall: "#7b8494",
  aisle: "#d8dee8"
};
