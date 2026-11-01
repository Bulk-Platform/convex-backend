use std::collections::HashMap;

use arrow_iceberg::{
    Array,
    BooleanArray,
    Float64Array,
    Int64Array,
    LargeBinaryArray,
    StringArray,
    TimestampMicrosecondArray,
};
use common::shapes::reduced::{
    ReducedField,
    ReducedFloatRange,
    ReducedShape,
};
use iceberg::{
    spec::NestedFieldRef,
    NamespaceIdent,
    TableCreation,
};
use value::{
    obj,
    ConvexObject,
    TableNumber,
};

use super::{
    super::tests::memory_catalog,
    *,
};

async fn table(catalog: &dyn Catalog) -> Result<Table> {
    let namespace = NamespaceIdent::new("exports".to_owned());
    catalog.create_namespace(&namespace, HashMap::new()).await?;
    let creation = TableCreation::builder()
        .name("menu".to_owned())
        .schema(metadata_schema()?)
        .build();
    Ok(catalog.create_table(&namespace, creation).await?)
}

fn change(id: &str, ts: u64, document: Option<ConvexObject>) -> Change {
    Change {
        id: id.to_owned(),
        ts,
        document,
    }
}

fn column<'a>(schema: &'a Schema, name: &str) -> (&'a Type, Option<&'a str>) {
    let field = schema
        .field_by_name(name)
        .unwrap_or_else(|| panic!("no column {name}"));
    (&field.field_type, field.doc.as_deref())
}

fn array<'a, T: 'static>(batch: &'a RecordBatch, name: &str) -> &'a T {
    batch
        .column_by_name(name)
        .unwrap_or_else(|| panic!("no column {name}"))
        .as_any()
        .downcast_ref()
        .unwrap_or_else(|| panic!("column {name} has another type"))
}

fn strings<'a>(batch: &'a RecordBatch, name: &str) -> &'a StringArray {
    array(batch, name)
}

#[tokio::test]
async fn the_first_page_decides_each_columns_kind() -> Result<()> {
    let catalog = memory_catalog().await?;
    let table = table(catalog.as_ref()).await?;
    let changes = vec![
        change(
            "a",
            1,
            Some(obj!(
                "_id" => "a",
                "_creationTime" => 1_700_000_000_000.5,
                "name" => "burger",
                "price" => 9.5,
                "count" => 3i64,
                "ok" => true,
                "blob" => vec![1u8, 2],
                "tags" => [1.0],
                "meta" => {},
                "nothing" => null,
            )?),
        ),
        change("b", 2, Some(obj!("_id" => "b", "name" => "soup")?)),
    ];
    let table = add_columns(catalog.as_ref(), &table, &changes).await?;
    let schema = table.metadata().current_schema();
    let string = Type::Primitive(PrimitiveType::String);
    assert_eq!(column(schema, "name"), (&string, None));
    assert_eq!(
        column(schema, "price"),
        (&Type::Primitive(PrimitiveType::Double), None)
    );
    assert_eq!(
        column(schema, "count"),
        (&Type::Primitive(PrimitiveType::Long), None)
    );
    assert_eq!(
        column(schema, "ok"),
        (&Type::Primitive(PrimitiveType::Boolean), None)
    );
    assert_eq!(
        column(schema, "blob"),
        (&Type::Primitive(PrimitiveType::Binary), None)
    );
    assert_eq!(column(schema, "tags"), (&string, Some(JSON_DOC)));
    assert_eq!(column(schema, "meta"), (&string, Some(JSON_DOC)));
    // Null decides nothing, and `_id` and `_creationTime` are metadata columns.
    assert!(schema.field_by_name("nothing").is_none());
    assert_eq!(
        column(schema, CREATION_TIME_COLUMN),
        (&Type::Primitive(PrimitiveType::Timestamptz), None)
    );
    assert_eq!(
        schema.as_struct().fields().len(),
        METADATA_COLUMNS.len() + 7
    );

    let batch = batch(schema, &changes)?;
    assert_eq!(strings(&batch, ID_COLUMN).value(0), "a");
    assert_eq!(strings(&batch, "name").value(1), "soup");
    let created: &TimestampMicrosecondArray = array(&batch, CREATION_TIME_COLUMN);
    assert_eq!(created.value(0), 1_700_000_000_000_500);
    assert!(created.is_null(1));
    let prices: &Float64Array = array(&batch, "price");
    assert_eq!(prices.value(0), 9.5);
    assert!(prices.is_null(1));
    let counts: &Int64Array = array(&batch, "count");
    assert_eq!(counts.value(0), 3);
    let oks: &BooleanArray = array(&batch, "ok");
    assert!(oks.value(0));
    let blobs: &LargeBinaryArray = array(&batch, "blob");
    assert_eq!(blobs.value(0), [1u8, 2]);
    assert_eq!(strings(&batch, "tags").value(0), "[1.0]");
    assert_eq!(strings(&batch, "meta").value(0), "{}");
    // The null field has no column, so its null is kept in `_rescued`.
    assert_eq!(
        strings(&batch, RESCUED_COLUMN).value(0),
        r#"{"nothing":null}"#
    );
    assert!(strings(&batch, RESCUED_COLUMN).is_null(1));
    // A second call adds nothing.
    assert!(new_columns(schema, &changes)?.is_empty());
    Ok(())
}

#[tokio::test]
async fn mixed_kinds_make_a_json_column_that_takes_every_kind() -> Result<()> {
    let catalog = memory_catalog().await?;
    let table = table(catalog.as_ref()).await?;
    let changes = vec![
        change("a", 1, Some(obj!("v" => "x")?)),
        change("b", 2, Some(obj!("v" => 1i64)?)),
    ];
    let table = add_columns(catalog.as_ref(), &table, &changes).await?;
    let schema = table.metadata().current_schema();
    assert_eq!(
        column(schema, "v"),
        (&Type::Primitive(PrimitiveType::String), Some(JSON_DOC))
    );
    let later = vec![change("c", 3, Some(obj!("v" => {"k" => true})?))];
    let batch = batch(schema, &[changes, later].concat())?;
    let values = strings(&batch, "v");
    assert_eq!(values.value(0), "\"x\"");
    assert_eq!(values.value(1), "1");
    assert_eq!(values.value(2), "{\"k\":true}");
    assert!(strings(&batch, RESCUED_COLUMN).is_null(2));
    Ok(())
}

#[tokio::test]
async fn ints_and_floats_share_a_double_column() -> Result<()> {
    let catalog = memory_catalog().await?;
    let table = table(catalog.as_ref()).await?;
    let changes = vec![
        change("a", 1, Some(obj!("price" => 4i64)?)),
        change("b", 2, Some(obj!("price" => 9.5)?)),
        change("c", 3, Some(obj!("price" => (1i64 << 53) + 1)?)),
    ];
    let table = add_columns(catalog.as_ref(), &table, &changes).await?;
    let schema = table.metadata().current_schema();
    assert_eq!(
        column(schema, "price"),
        (&Type::Primitive(PrimitiveType::Double), None)
    );
    let batch = batch(schema, &changes)?;
    let prices: &Float64Array = array(&batch, "price");
    assert_eq!(prices.value(0), 4.0);
    assert_eq!(prices.value(1), 9.5);
    // An int64 a double cannot hold exactly is rescued instead of rounded.
    assert!(prices.is_null(2));
    assert_eq!(
        strings(&batch, RESCUED_COLUMN).value(2),
        r#"{"price":9007199254740993}"#
    );
    Ok(())
}

#[tokio::test]
async fn values_that_do_not_fit_are_rescued() -> Result<()> {
    let catalog = memory_catalog().await?;
    let table = table(catalog.as_ref()).await?;
    let first = vec![change("a", 1, Some(obj!("n" => 1.0, "s" => "x")?))];
    let table = add_columns(catalog.as_ref(), &table, &first).await?;
    let second = vec![change(
        "b",
        2,
        Some(obj!(
            "n" => "oops",
            "s" => {"nested" => 1.0},
            "has space" => 1.0,
            "N" => 2.0,
            "Name" => "same",
            "name" => "case",
            "_deleted" => true,
        )?),
    )];
    let table = add_columns(catalog.as_ref(), &table, &second).await?;
    let schema = table.metadata().current_schema();
    // Of two new names that differ only by case, the first in sort order wins.
    assert!(schema.field_by_name("Name").is_some());
    assert!(schema.field_by_name("name").is_none());
    assert!(schema.field_by_name("N").is_none());
    assert!(schema.field_by_name("has space").is_none());
    // Iceberg readers would resolve `_deleted` to their own metadata column.
    assert!(schema.field_by_name("_deleted").is_none());

    let batch = batch(schema, &second)?;
    let numbers: &Float64Array = array(&batch, "n");
    assert!(numbers.is_null(0));
    assert!(strings(&batch, "s").is_null(0));
    assert_eq!(strings(&batch, "Name").value(0), "same");
    assert_eq!(
        strings(&batch, RESCUED_COLUMN).value(0),
        r#"{"N":2.0,"_deleted":true,"has space":1.0,"n":"oops","name":"case","s":{"nested":1.0}}"#
    );
    Ok(())
}

#[tokio::test]
async fn seeds_follow_the_table_shape() -> Result<()> {
    let catalog = memory_catalog().await?;
    let table = table(catalog.as_ref()).await?;
    let field = |shape| ReducedField {
        optional: false,
        shape,
    };
    let float = ReducedShape::Float64(ReducedFloatRange {
        has_special_values: false,
    });
    let users = TableNumber::try_from(7u32)?;
    let object = ReducedShape::Object(BTreeMap::from([
        ("_id".parse()?, field(ReducedShape::Id(users))),
        ("_creationTime".parse()?, field(float.clone())),
        ("name".parse()?, field(ReducedShape::String)),
        (
            "price".parse()?,
            field(ReducedShape::Union(BTreeSet::from([
                ReducedShape::Int64,
                float.clone(),
            ]))),
        ),
        ("count".parse()?, field(ReducedShape::Int64)),
        ("ok".parse()?, field(ReducedShape::Boolean)),
        ("blob".parse()?, field(ReducedShape::Bytes)),
        (
            "tags".parse()?,
            field(ReducedShape::Array(Box::new(ReducedShape::String))),
        ),
        (
            "owner".parse()?,
            field(ReducedShape::Union(BTreeSet::from([
                ReducedShape::Id(users),
                ReducedShape::Null,
            ]))),
        ),
        (
            "note".parse()?,
            field(ReducedShape::Union(BTreeSet::from([
                ReducedShape::String,
                ReducedShape::Null,
            ]))),
        ),
        (
            "mixed".parse()?,
            field(ReducedShape::Union(BTreeSet::from([
                ReducedShape::String,
                ReducedShape::Int64,
            ]))),
        ),
        ("nothing".parse()?, field(ReducedShape::Null)),
        ("later".parse()?, field(ReducedShape::Unknown)),
        ("_deleted".parse()?, field(ReducedShape::Boolean)),
    ]));
    // One document with too many fields makes the table a union of an object
    // and a record; the object still seeds.
    let shape = ReducedShape::Union(BTreeSet::from([
        object,
        ReducedShape::Record {
            key_shape: Box::new(ReducedShape::String),
            value_shape: Box::new(field(ReducedShape::Unknown)),
        },
    ]));
    let table_name = |n: TableNumber| (n == users).then(|| "users".parse().unwrap());
    let columns = seeds(&shape, table_name)?;
    assert_eq!(columns.len(), 9);
    let table = commit_columns(catalog.as_ref(), &table, columns).await?;
    let schema = table.metadata().current_schema();
    let string = Type::Primitive(PrimitiveType::String);
    assert_eq!(column(schema, "name"), (&string, None));
    assert_eq!(
        column(schema, "price"),
        (&Type::Primitive(PrimitiveType::Double), None)
    );
    assert_eq!(
        column(schema, "count"),
        (&Type::Primitive(PrimitiveType::Long), None)
    );
    assert_eq!(
        column(schema, "ok"),
        (&Type::Primitive(PrimitiveType::Boolean), None)
    );
    assert_eq!(
        column(schema, "blob"),
        (&Type::Primitive(PrimitiveType::Binary), None)
    );
    assert_eq!(column(schema, "tags"), (&string, Some(JSON_DOC)));
    assert_eq!(column(schema, "owner"), (&string, Some("convex:id:users")));
    assert_eq!(column(schema, "note"), (&string, None));
    assert_eq!(column(schema, "mixed"), (&string, Some(JSON_DOC)));
    // Metadata and reserved names, null-only and unknown fields seed nothing.
    for absent in ["_deleted", "nothing", "later"] {
        assert!(
            schema.field_by_name(absent).is_none(),
            "{absent} should not seed"
        );
    }
    assert_eq!(
        schema.as_struct().fields().len(),
        METADATA_COLUMNS.len() + 9
    );
    assert!(seeds(&ReducedShape::Unknown, |_| None)?.is_empty());
    Ok(())
}
