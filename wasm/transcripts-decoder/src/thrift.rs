//! Just enough of the Thrift compact protocol to read a Parquet page header.

use crate::Error;

pub struct Reader<'a> {
    pub data: &'a [u8],
    pub pos: usize,
}

const STOP: u8 = 0;
const BOOL_TRUE: u8 = 1;
const BOOL_FALSE: u8 = 2;
const BYTE: u8 = 3;
const I16: u8 = 4;
const I32: u8 = 5;
const I64: u8 = 6;
const DOUBLE: u8 = 7;
const BINARY: u8 = 8;
const LIST: u8 = 9;
const SET: u8 = 10;
const MAP: u8 = 11;
const STRUCT: u8 = 12;

impl<'a> Reader<'a> {

    fn byte(&mut self) -> Result<u8, Error> {
        let value = *self.data.get(self.pos).ok_or(Error::Malformed)?;
        self.pos += 1;
        Ok(value)
    }

    fn varint(&mut self) -> Result<u64, Error> {
        let mut value = 0u64;
        let mut shift = 0;
        loop {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 { return Ok(value); }
            shift += 7;
            if shift > 63 { return Err(Error::Malformed); }
        }
    }

    fn zigzag(&mut self) -> Result<i64, Error> {
        let value = self.varint()?;
        Ok(((value >> 1) as i64) ^ -((value & 1) as i64))
    }

    fn skip_bytes(&mut self, count: usize) -> Result<(), Error> {
        if self.pos + count > self.data.len() { return Err(Error::Malformed); }
        self.pos += count;
        Ok(())
    }

    /// The next field of the current struct as (field id, type), or None at its end.
    pub fn field(&mut self, last: &mut i16) -> Result<Option<(i16, u8)>, Error> {
        let header = self.byte()?;
        if header == STOP { return Ok(None); }
        let kind = header & 0x0f;
        let delta = (header >> 4) as i16;
        let id = if delta == 0 { self.zigzag()? as i16 } else { *last + delta };
        *last = id;
        Ok(Some((id, kind)))
    }

    pub fn int(&mut self) -> Result<i64, Error> { self.zigzag() }

    pub fn skip(&mut self, kind: u8) -> Result<(), Error> {
        match kind {
            BOOL_TRUE | BOOL_FALSE => Ok(()),
            BYTE => self.skip_bytes(1),
            I16 | I32 | I64 => self.varint().map(|_| ()),
            DOUBLE => self.skip_bytes(8),
            BINARY => { let length = self.varint()? as usize; self.skip_bytes(length) }
            LIST | SET => {
                let header = self.byte()?;
                let mut size = (header >> 4) as usize;
                if size == 15 { size = self.varint()? as usize; }
                let element = header & 0x0f;
                for _ in 0..size { self.skip(element)?; }
                Ok(())
            }
            MAP => {
                let size = self.varint()? as usize;
                if size == 0 { return Ok(()); }
                let types = self.byte()?;
                for _ in 0..size { self.skip(types >> 4)?; self.skip(types & 0x0f)?; }
                Ok(())
            }
            STRUCT => {
                let mut last = 0;
                while let Some((_, inner)) = self.field(&mut last)? { self.skip(inner)?; }
                Ok(())
            }
            _ => Err(Error::Malformed),
        }
    }
}

pub fn is_true(kind: u8) -> bool { kind == BOOL_TRUE }
pub fn is_i32(kind: u8) -> bool { kind == I32 || kind == I16 || kind == I64 || kind == BYTE }
pub fn is_struct(kind: u8) -> bool { kind == STRUCT }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_fields_and_skips_unknown_ones() {
        // struct { 1: i32 = 5, 2: binary "ab", 4: struct { 1: i32 = -1 }, 5: i32 = 7 }
        let data = [0x15, 0x0a, 0x18, 0x02, b'a', b'b', 0x2c, 0x15, 0x01, 0x00, 0x15, 0x0e, 0x00];
        let mut reader = Reader { data: &data, pos: 0 };
        let mut last = 0;
        assert_eq!(reader.field(&mut last).unwrap(), Some((1, I32)));
        assert_eq!(reader.int().unwrap(), 5);
        assert_eq!(reader.field(&mut last).unwrap(), Some((2, BINARY)));
        reader.skip(BINARY).unwrap();
        assert_eq!(reader.field(&mut last).unwrap(), Some((4, STRUCT)));
        reader.skip(STRUCT).unwrap();
        assert_eq!(reader.field(&mut last).unwrap(), Some((5, I32)));
        assert_eq!(reader.int().unwrap(), 7);
        assert_eq!(reader.field(&mut last).unwrap(), None);
    }
}
