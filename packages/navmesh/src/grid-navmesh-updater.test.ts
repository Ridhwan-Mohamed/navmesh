import NavMesh from "./navmesh";
import GridNavMeshUpdater from "./grid-navmesh-updater";
import Vector2 from "./math/vector-2";

const v2 = (x: number, y: number) => new Vector2(x, y);

describe("GridNavMeshUpdater", () => {
  // prettier-ignore
  const left = [v2(0,0), v2(10,0), v2(10,10), v2(0,10)];
  // prettier-ignore
  const right = [v2(20,0), v2(30,0), v2(30,10), v2(20,10)];
  // prettier-ignore
  const span = [v2(0,0), v2(30,0), v2(30,10), v2(0,10)];

  it("should open a blocked tile between polygons without rebuilding the full mesh", () => {
    const navMesh = new NavMesh([left, right]);
    const updater = new GridNavMeshUpdater(navMesh, { tileWidth: 10, tileHeight: 10 });

    const result = updater.openTile(1, 0);

    expect(result.removedPolyIds).toEqual([0, 1]);
    expect(result.addedPolyIds).toEqual([2]);
    expect(navMesh.findPath(v2(5, 5), v2(25, 5))).toEqual([v2(5, 5), v2(25, 5)]);
  });

  it("should block a tile inside a polygon and split the local region", () => {
    const navMesh = new NavMesh([span]);
    const updater = new GridNavMeshUpdater(navMesh, { tileWidth: 10, tileHeight: 10 });

    const result = updater.blockTile(1, 0);

    expect(result.removedPolyIds).toEqual([0]);
    expect(result.addedPolyIds).toEqual([1, 2]);
    expect(navMesh.findPath(v2(5, 5), v2(25, 5))).toBeNull();
  });

  it("should open a tile range into an empty mesh", () => {
    const navMesh = new NavMesh([]);
    const updater = new GridNavMeshUpdater(navMesh, { tileWidth: 10, tileHeight: 10 });

    const result = updater.openRange(2, 3, 3, 3);

    expect(result.removedPolyIds).toEqual([]);
    expect(result.addedPolyIds).toEqual([0]);
    expect(navMesh.findPath(v2(25, 35), v2(35, 35))).toEqual([v2(25, 35), v2(35, 35)]);
  });
});
