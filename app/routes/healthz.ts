export const loader = async () => {
  return Response.json({
    ok: true,
    service: "easy-migrate",
    timestamp: new Date().toISOString(),
  });
};
