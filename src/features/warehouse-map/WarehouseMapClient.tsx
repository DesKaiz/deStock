
"use client";

import { useEffect, useState } from "react";

export default function WarehouseMapClient() {
  const [WarehouseApp, setWarehouseApp] = useState<React.ComponentType | null>(null);

  useEffect(() => {
    import("./WarehouseApp").then((module) => {
      setWarehouseApp(() => module.default);
    });
  }, []);

  if (!WarehouseApp) {
    return <main style={{ padding: 32 }}>Depo haritası yükleniyor...</main>;
  }

  return <WarehouseApp />;
}
